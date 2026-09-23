/**
 * BOPF runtime exerciser — generates an `IF_OO_ADT_CLASSRUN` bridge that drives
 * a business object through `/BOBF/IF_TRA_SERVICE_MANAGER` and
 * `/BOBF/IF_TRA_TRANSACTION_MANAGER`, then parses what it printed.
 *
 * There is no BOPF runtime/data endpoint in ADT — the classrun bridge (proven
 * end to end on A4H) is the only automatable route. Sibling of the report
 * bridge (`src/adt/run.ts`): same `assertPlainName` injection defence, same
 * byte-stability rule, same write → activate → fresh-session-run choreography.
 *
 * Never guessed: the constants interface name (naming convention is
 * unreliable — read from `BoModel`, never derived) and a missing
 * `persistentTableRef` (normal pre-activation; disclosed via `ZMCP-ERR>`,
 * never treated as an error).
 */
import { createHash } from "node:crypto";
import type { AbapConnection } from "./connection.js";
import type { SafetyGate } from "../safety.js";
import { AbapError } from "./errors.js";
import {
  assertPlainName,
  deployBridge,
  ERR_LINE_PREFIX,
  executeBridge,
  MAX_NAME,
  verifyBridgeActivation,
} from "./run.js";
import type { BoAssociation, BoModel, BoNode } from "./bopf-types.js";

export type { BoModel } from "./bopf-types.js";

// ---------------------------------------------------------------------------
// Model-shape helpers — narrow the real BoModel/BoNode/BoAssociation
// (bopf-types.ts) down to exactly what the generator below needs.
// ---------------------------------------------------------------------------

/**
 * bo:constantsInterfaceRef — READ from the model, NEVER derived (naming
 * convention is unreliable, e.g. `ZBOPF_RT1` → `ZIF_BOPF_RT11_C`). Absence is
 * a hard error, not proof the BO was never activated (see archive).
 */
function constantsInterfaceName(model: BoModel): string {
  const name = model.constantsInterfaceRef?.name;
  if (!name) {
    throw new AbapError(
      "BAD_INPUT",
      `Model "${model.name}" has no constantsInterfaceRef, and the name cannot be derived ` +
        "(the naming convention is unreliable) — cannot generate a test bridge without it.",
      { bo: model.name },
    );
  }
  return name;
}

/**
 * DDIC structure backing a node's row type for MODIFY/RETRIEVE traffic:
 * `combinedStructureRef`, falling back to `persistentStructureRef` only when
 * absent. This precedence was live-verified against `ZBOPF_V7` — the
 * persistent structure alone lacks KEY/PARENT_KEY/ROOT_KEY and fails ABAP
 * syntax check on `<row>-key` (see archive: originally backwards, fixed).
 */
function nodeStructureRef(node: BoNode): string {
  const name = node.combinedStructureRef?.name ?? node.persistentStructureRef?.name;
  if (!name) {
    throw new AbapError(
      "BAD_INPUT",
      `Node "${node.name}" has neither a combinedStructureRef nor a persistentStructureRef — ` +
        "cannot determine its row structure.",
      { node: node.name },
    );
  }
  return name;
}

/**
 * DDIC transparent table backing this node, when persisted. Absent is normal
 * pre-activation — never treat a missing tableRef as an error;
 * callers disclose it via a `ZMCP-ERR>` line instead of silently skipping it.
 */
function nodeTableRef(node: BoNode): string | undefined {
  return node.persistentTableRef?.name;
}

/**
 * The bare node name an association's `targetNodeRef` points at.
 *
 * On the wire, `targetNodeRef.name` is the full `<BO>~<NODE>` ADT object
 * name, not the bare node name callers pass — comparing raw broke every
 * multi-node composite (see archive: ROOT CAUSE, defect in `abap_bopf_test`).
 * Prefer `targetNodeRef.uri` (an XPath fragment keyed by bare name); fall
 * back to splitting `name` on the last `~`; fall back to `name` unchanged
 * (keeps synthetic test fixtures using already-bare names working).
 */
function targetNodeName(ref: BoAssociation["targetNodeRef"]): string | undefined {
  if (!ref) return undefined;
  if (ref.uri) {
    const m = /bo:nodes\[@bo:name='([^']*)'\]\s*$/.exec(ref.uri);
    if (m) return m[1];
  }
  const tilde = ref.name.lastIndexOf("~");
  return tilde >= 0 ? ref.name.slice(tilde + 1) : ref.name;
}

/**
 * The association from `parentNodeName` to `targetNodeName`, if the model
 * declares exactly one. Associations are owned by their source node
 * (`BoNode.associations`), so this looks up the owning node first.
 */
function findAssociation(
  model: BoModel,
  parentNodeName: string,
  wantedTargetNodeName: string,
): BoAssociation | undefined {
  const parent = model.nodes.find((n) => n.name === parentNodeName);
  return parent?.associations.find((a) => targetNodeName(a.targetNodeRef) === wantedTargetNodeName);
}

// ---------------------------------------------------------------------------
// Scenario input types
// ---------------------------------------------------------------------------

export interface BopfTestNodeInput {
  /** Node name, validated against `model.nodes`. */
  node: string;
  /** Parent node name. REQUIRED for every node except the root; omit for the root. */
  parentNode?: string;
  /** field name (validated with assertPlainName) -> literal string value.
   *  Non-string values must be rejected, never coerced (injection-defense rule). */
  fields: Record<string, string>;
}

export interface BopfTestScenario {
  /** scenario.nodes[0] MUST be the BO's root node (model.nodes.find(n => n.rootNode)).
   *  Every other entry needs parentNode set, and (parentNode, node) must resolve
   *  to exactly one association owned by the parent node
   *  (model.nodes.find(n => n.name === parentNode)?.associations). */
  nodes: BopfTestNodeInput[];
  /** Append a delete-and-save cleanup step to the generated class ("optional cleanup"). */
  cleanup?: boolean;
}

// ---------------------------------------------------------------------------
// Bridge class naming
// ---------------------------------------------------------------------------

/** 12 chars, leaving 18 of the 30-char ABAP name limit (run.ts's report
 *  bridge uses `ZCL_ZMCP_RUN_`, 13 chars / 17 budget). */
export const BOPF_BRIDGE_CLASS_PREFIX = "ZCL_ZMCP_BO_";
/** Hex digits of the disambiguating hash appended to truncated names. */
const HASH_LEN = 6;

/** Deterministic bridge-class name for a BO, ≤ 30 chars. Same truncate +
 *  SHA-256 disambiguation algorithm as `bridgeClassName` (`src/adt/run.ts`). */
export function bopfBridgeClassName(bo: string): string {
  const canon = assertPlainName(bo, "BO name").toUpperCase();
  const safe = canon.replace(/[^A-Z0-9_]/g, "_");
  const budget = MAX_NAME - BOPF_BRIDGE_CLASS_PREFIX.length; // 18
  if (safe.length <= budget && safe === canon) return BOPF_BRIDGE_CLASS_PREFIX + safe;

  const hash = createHash("sha256").update(canon, "utf8").digest("hex").slice(0, HASH_LEN).toUpperCase();
  const keep = safe.slice(0, budget - HASH_LEN - 1); // 11 chars + "_" + 6 = 18
  return `${BOPF_BRIDGE_CLASS_PREFIX}${keep}_${hash}`;
}

// ---------------------------------------------------------------------------
// Bridge class source
// ---------------------------------------------------------------------------

/** Prefix the generated bridge puts on every line of its own transcript. */
export const BOPF_LINE_PREFIX = "BOPF> ";

/** ABAP source lines are hard-capped at 255 characters; wrap generated
 *  statements well before that so nothing realistic gets close. */
const MAX_ABAP_LINE = 255;
/** Soft wrap target for generated statement lines. */
const MAX_WRAP_LINE = 120;
/** A literal longer than this triggers `&&`-piece splitting at all. */
const LITERAL_PIECE_MAX = 100;
/** Character budget per `|...|` piece of a transcript DATA line — keeps the
 *  wrapped `&&`-joined assignment comfortably under 120 columns per line. */
const FIELD_LINE_BUDGET = 90;

/**
 * Split a literal (single quotes already doubled) into pieces safe to embed
 * as `'<piece>'` and `&&`-join across lines. `firstMax` bounds the first
 * piece (sized to leave room for the caller's own line prefix, e.g.
 * `ls_<id>-<field> = '`); every later piece is bounded by `restMax`. Never
 * cuts between the two characters of a doubled `''` — the cut point is
 * pulled back by one when it would land there.
 */
function splitLiteralPieces(literal: string, firstMax: number, restMax: number): string[] {
  const quotesBefore = new Array<number>(literal.length + 1);
  quotesBefore[0] = 0;
  for (let i = 0; i < literal.length; i++) {
    quotesBefore[i + 1] = quotesBefore[i]! + (literal[i] === "'" ? 1 : 0);
  }
  const pieces: string[] = [];
  let pos = 0;
  let budget = firstMax;
  while (pos < literal.length) {
    let end = Math.min(pos + budget, literal.length);
    // A cut lands inside a doubled quote iff both neighbouring chars are `'`
    // AND the left one is the FIRST of the pair (an even count of quotes
    // precede it) — pull the cut back before the pair in that case.
    if (end < literal.length && literal[end - 1] === "'" && literal[end] === "'" && quotesBefore[end - 1]! % 2 === 0) {
      end -= 1;
    }
    if (end <= pos) end = pos + 1; // defensive: always make progress
    pieces.push(literal.slice(pos, end));
    pos = end;
    budget = restMax;
  }
  return pieces;
}

/**
 * Group `field={ <row>-field }` tokens into `|...|` piece bodies (each
 * carrying the single leading space it needs to reproduce the original
 * single-space-joined field list once every piece is `&&`-concatenated),
 * keeping each piece under `FIELD_LINE_BUDGET` chars.
 */
function chunkFieldTokens(fields: Array<{ nameLower: string }>, rowRef: string): string[] {
  const tokens = fields.map((f) => `${f.nameLower}={ ${rowRef}-${f.nameLower} }`);
  const groups: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const tok of tokens) {
    const addLen = tok.length + 1; // +1 for the separating space
    if (current.length > 0 && currentLen + addLen > FIELD_LINE_BUDGET) {
      groups.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(tok);
    currentLen += addLen;
  }
  if (current.length > 0) groups.push(current);
  return groups.map((g) => " " + g.join(" "));
}

/**
 * Split a single-space-joined template body into `&&`-joinable chunks,
 * never breaking a word. `firstMax`/`restMax` bound the first/later chunks;
 * concatenating the returned chunks with `" "` reproduces `tpl` exactly.
 */
function wrapTemplateWords(tpl: string, firstMax: number, restMax: number): string[] {
  // Split only at spaces outside `{ ... }` — a cut inside an embedded
  // expression would leave `|... { lines( |` behind, which does not compile.
  const words: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of tpl) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === " " && depth === 0) {
      words.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  words.push(current);
  const chunks: string[] = [];
  let chunk = "";
  let budget = firstMax;
  for (const w of words) {
    const candidate = chunk ? `${chunk} ${w}` : w;
    if (chunk && candidate.length > budget) {
      chunks.push(chunk);
      chunk = w;
      budget = restMax;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/**
 * TAG FORMAT — owned jointly by `bopfBridgeSource` and `parseBopfTranscript`;
 * change one, change the other (a test in `test/bopf-runtime.test.ts` catches
 * drift). Sub-tags within the `BOPF>` transcript: `MSG`, `DATA`, `KEY`, and an
 * `ev_rejected=` substring (see `parseBopfTranscript` below for exact
 * shapes). Unrecognised lines are plain narration, kept in `transcript` only.
 */

/**
 * The generated `IF_OO_ADT_CLASSRUN` wrapper that exercises a BO scenario.
 *
 * Byte-stable for the same `(model, scenario, className)` — no timestamps,
 * counters, or random IDs in the source text (GUIDs come from an ABAP-side
 * call at runtime). This is what lets `writeObject`'s identical-source
 * short-circuit skip the PUT when nothing changed.
 *
 * Validates everything before generating a line: every identifier embedded in
 * ABAP source goes through `assertPlainName`; every field VALUE is emitted as
 * a single-quoted literal with `'` doubled, never coerced from a non-string.
 */
export function bopfBridgeSource(model: BoModel, scenario: BopfTestScenario, className: string): string {
  const cls = assertPlainName(className, "Bridge class name").toLowerCase();
  const boName = assertPlainName(model.name, "BO name").toLowerCase();
  const cif = assertPlainName(constantsInterfaceName(model), "Constants interface").toLowerCase();

  if (scenario.nodes.length === 0) {
    throw new AbapError(
      "BAD_INPUT",
      "scenario.nodes must contain at least one node (the BO's root).",
      { bo: model.name },
    );
  }

  const first = scenario.nodes[0]!;
  if (first.parentNode !== undefined) {
    throw new AbapError(
      "BAD_INPUT",
      `The first scenario node ("${first.node}") is the BO's root and must not set parentNode.`,
      { node: first.node, parentNode: first.parentNode },
    );
  }

  const rootModelNode = model.nodes.find((n) => n.rootNode);
  if (!rootModelNode) {
    throw new AbapError("BAD_INPUT", `Model "${model.name}" has no node marked rootNode.`, {
      bo: model.name,
    });
  }
  if (first.node !== rootModelNode.name) {
    throw new AbapError(
      "BAD_INPUT",
      `scenario.nodes[0] must be the BO's root node ("${rootModelNode.name}"), got "${first.node}".`,
      { expected: rootModelNode.name, got: first.node },
    );
  }

  // Every LOCAL ABAP identifier must be keyed by scenario SLOT, not node
  // NAME — a scenario can repeat a node name (e.g. two ITEM rows), and
  // name-keyed identifiers collided, failing ABAP syntax check on
  // activation. `sc_node-`/`sc_association-` references stay name-keyed
  // (they resolve against BOPF's own generated constants interface). See
  // archive for the live-confirmed root cause.
  interface Resolved {
    scenario: BopfTestNodeInput;
    model: BoNode;
    /** Index into `resolved` — unique per scenario entry. */
    slot: number;
    /** `${nameLower}_${slot}` — namespace for every LOCAL ABAP variable and
     *  stage label this entry generates. Slot-keyed, never name-keyed. */
    idLower: string;
    /** Real model node name, lowercased. Only for `sc_node-`/
     *  `sc_association-` references — never a local ABAP variable name. */
    nameLower: string;
    structureRefLower: string;
    tableRefLower?: string;
    /** Real PARENT node name, lowercased — same rule as `nameLower`. */
    parentNameLower?: string;
    /** Resolved parent SLOT's `idLower` — feeds local parent variable
     *  references. See the slot-resolution rule at the push site below. */
    parentIdLower?: string;
    associationNameLower?: string;
    fields: Array<{ nameLower: string; literal: string }>;
  }

  const resolved: Resolved[] = [];

  for (let i = 0; i < scenario.nodes.length; i++) {
    const sn = scenario.nodes[i]!;
    const modelNode = model.nodes.find((n) => n.name === sn.node);
    if (!modelNode) {
      throw new AbapError(
        "BAD_INPUT",
        `Scenario references node "${sn.node}", which does not exist in the model ` +
          `(known nodes: ${model.nodes.map((n) => n.name).join(", ") || "none"}).`,
        { node: sn.node },
      );
    }
    const structureRef = nodeStructureRef(modelNode);
    const tableRef = nodeTableRef(modelNode);
    // The model is parsed input, not trusted — every identifier embedded in
    // generated ABAP source must itself be validated as a plain name.
    assertPlainName(modelNode.name, "Node name");
    assertPlainName(structureRef, "Node structure reference");
    if (tableRef !== undefined) assertPlainName(tableRef, "Node table reference");

    const nameLower = assertPlainName(sn.node, "Scenario node name").toLowerCase();
    // Defense-in-depth: `nameLower`+`i` can never actually fail this check,
    // but re-validating guards against a future change to either half.
    const idLower = assertPlainName(`${nameLower}_${i}`, "Generated slot identifier").toLowerCase();

    let parentNameLower: string | undefined;
    let parentIdLower: string | undefined;
    let associationNameLower: string | undefined;
    if (i > 0) {
      if (!sn.parentNode) {
        throw new AbapError(
          "BAD_INPUT",
          `Scenario node "${sn.node}" (index ${i}) is not the root and must set parentNode.`,
          { node: sn.node, index: i },
        );
      }
      const assoc = findAssociation(model, sn.parentNode, modelNode.name);
      if (!assoc) {
        const fromParent = model.nodes.find((n) => n.name === sn.parentNode)?.associations ?? [];
        // Bare node name (never the raw `<BO>~<NODE>` wire form) — this is
        // what the caller would write in scenario.nodes[].node.
        const alt = fromParent.length
          ? `associations that DO exist from "${sn.parentNode}": ` +
            fromParent.map((a) => `${a.name} -> ${targetNodeName(a.targetNodeRef) ?? "?"}`).join(", ")
          : `no associations exist from "${sn.parentNode}" at all`;
        throw new AbapError(
          "BAD_INPUT",
          `No association from node "${sn.parentNode}" to node "${modelNode.name}" exists in the model (${alt}).`,
          { parentNode: sn.parentNode, node: modelNode.name },
        );
      }
      assertPlainName(sn.parentNode, "Association source node");
      // Validate the EXTRACTED bare name, not raw `targetNodeRef.name`
      // (contains `~` on the wire — see `targetNodeName` above). Equals
      // `modelNode.name` by construction; re-asserted as defense-in-depth.
      assertPlainName(targetNodeName(assoc.targetNodeRef) ?? "", "Association target node");
      assertPlainName(assoc.name, "Association name");
      parentNameLower = assertPlainName(sn.parentNode, "Scenario parent node name").toLowerCase();
      associationNameLower = assoc.name.toLowerCase();

      // `parentNode` names a NODE, not a specific scenario ROW. When a node
      // name repeats in the scenario, resolve to the NEAREST PRECEDING entry
      // with that node name (deterministic; matches "attach to whichever
      // <node> I just added").
      let parentSlot: number | undefined;
      for (let j = resolved.length - 1; j >= 0; j--) {
        if (resolved[j]!.model.name === sn.parentNode) {
          parentSlot = j;
          break;
        }
      }
      if (parentSlot === undefined) {
        // parentNode must resolve against an EARLIER entry in scenario.nodes,
        // not merely against the model (see archive for how this gap was
        // previously masked by name-keyed accidental matches).
        throw new AbapError(
          "BAD_INPUT",
          `Scenario node "${sn.node}" (index ${i}) sets parentNode="${sn.parentNode}", but no earlier ` +
            `entry in scenario.nodes is node "${sn.parentNode}". parentNode must name a node that already ` +
            "appears earlier in scenario.nodes, not merely one that exists in the model.",
          { node: sn.node, index: i, parentNode: sn.parentNode },
        );
      }
      parentIdLower = resolved[parentSlot]!.idLower;
    }

    const fields: Array<{ nameLower: string; literal: string }> = [];
    for (const [fieldName, fieldValue] of Object.entries(sn.fields)) {
      assertPlainName(fieldName, `Field name on node "${sn.node}"`);
      if (typeof fieldValue !== "string") {
        throw new AbapError(
          "BAD_INPUT",
          `Field "${fieldName}" on node "${sn.node}" must be a string; got ${typeof fieldValue}. ` +
            "Values are never coerced.",
          { node: sn.node, field: fieldName, receivedType: typeof fieldValue },
        );
      }
      fields.push({ nameLower: fieldName.toLowerCase(), literal: fieldValue.replace(/'/g, "''") });
    }

    resolved.push({
      scenario: sn,
      model: modelNode,
      slot: i,
      idLower,
      nameLower,
      structureRefLower: structureRef.toLowerCase(),
      tableRefLower: tableRef?.toLowerCase(),
      parentNameLower,
      parentIdLower,
      associationNameLower,
      fields,
    });
  }

  // Root row's slot is always 0 (enforced above) — never name-keyed.
  const rootIdLower = resolved[0]!.idLower;

  // -------------------------------------------------------------------------
  // Generate.
  // -------------------------------------------------------------------------
  const body: string[] = [];
  let step = 1;
  let msgN = 1;

  const write = (s: string) => body.push(s);
  const emitOut = (text: string) => write(`        out->write( '${BOPF_LINE_PREFIX}${text}' ).`);
  // Long node/association names (assertPlainName allows up to 40 chars,
  // repeated more than once in e.g. the retrieve_by_association STEP line)
  // can push a single-line emission past MAX_WRAP_LINE (or, in the worst
  // case, past MAX_ABAP_LINE) — wrap on word boundaries when that happens.
  const emitOutTpl = (tpl: string): void => {
    const full = `        out->write( |${BOPF_LINE_PREFIX}${tpl}| ).`;
    if (full.length <= MAX_WRAP_LINE) {
      write(full);
      return;
    }
    const chunks = wrapTemplateWords(tpl, 85, 100);
    if (chunks.length === 1) {
      write(full);
      return;
    }
    write(`        out->write( |${BOPF_LINE_PREFIX}${chunks[0]} |`);
    for (let k = 1; k < chunks.length; k++) {
      const isLast = k === chunks.length - 1;
      write(`          && |${chunks[k]}${isLast ? "" : " "}|${isLast ? " )." : ""}`);
    }
  };

  // Maps a `body` index (0-based, pre-header) to the scenario node/field that
  // produced it — consulted only by the pre-flight line-length check below.
  const fieldLineOwners = new Map<number, { node: string; field: string }>();

  /** Writes a (possibly `&&`-wrapped) `ls_<id>-<field> = '<literal>'.`
   *  assignment and records which node/field owns every line it wrote. */
  const writeFieldAssignment = (idLower: string, nodeNameLower: string, fieldNameLower: string, literal: string): void => {
    const startIndex = body.length;
    let pieces: string[];
    if (literal.length <= LITERAL_PIECE_MAX) {
      pieces = [literal];
    } else {
      // Size the first piece so the prefixed first line (which carries
      // `ls_<id>-<field> = '`, unlike every continuation line) still lands
      // at or under MAX_WRAP_LINE; later pieces use the plain 100-char cap.
      const prefixLen = `        ls_${idLower}-${fieldNameLower} = '`.length;
      const firstMax = Math.max(10, Math.min(LITERAL_PIECE_MAX, MAX_WRAP_LINE - prefixLen - 1));
      pieces = splitLiteralPieces(literal, firstMax, LITERAL_PIECE_MAX);
    }
    if (pieces.length === 1) {
      write(`        ls_${idLower}-${fieldNameLower} = '${pieces[0]}'.`);
    } else {
      write(`        ls_${idLower}-${fieldNameLower} = '${pieces[0]}'`);
      for (let k = 1; k < pieces.length; k++) {
        const isLast = k === pieces.length - 1;
        write(`          && '${pieces[k]}'${isLast ? "." : ""}`);
      }
    }
    for (let idx = startIndex; idx < body.length; idx++) {
      fieldLineOwners.set(idx, { node: nodeNameLower, field: fieldNameLower });
    }
  };

  /** Writes `lv_line_<id> = |piece0| && |piece1| ... .` then
   *  `out->write( lv_line_<id> ).` — the wrapped transcript DATA line. */
  const writeLineVar = (idLower: string, pieces: string[]): void => {
    if (pieces.length === 1) {
      write(`        lv_line_${idLower} = |${pieces[0]}|.`);
    } else {
      write(`        lv_line_${idLower} = |${pieces[0]}|`);
      for (let k = 1; k < pieces.length; k++) {
        const isLast = k === pieces.length - 1;
        write(`          && |${pieces[k]}|${isLast ? "." : ""}`);
      }
    }
    write(`        out->write( lv_line_${idLower} ).`);
  };

  emitOut(`STEP${step++} OK service manager obtained`);
  // (placeholder overwritten below — real emission happens inline with the calls)
  body.length = 0;
  step = 1;
  msgN = 1;

  write(`        DATA(lo_sm) = /bobf/cl_tra_serv_mgr_factory=>get_service_manager( ${cif}=>sc_bo_key ).`);
  emitOut(`STEP${step++} OK service manager obtained`);
  write("");
  write("        DATA(lo_tm) = /bobf/cl_tra_trans_mgr_factory=>get_transaction_manager( ).");
  emitOut(`STEP${step++} OK transaction manager obtained`);
  write("");

  // Local identifiers below are keyed by `r.idLower` (slot-unique);
  // `sc_node-`/`sc_association-` references stay keyed by `r.nameLower` (they
  // resolve against BOPF's own generated constants interface).
  for (const r of resolved) {
    write(`        DATA(lv_key_${r.idLower}) = /bobf/cl_frw_factory=>get_new_key( ).`);
    emitOutTpl(`KEY ${r.idLower}={ lv_key_${r.idLower} }`);
  }
  write("");

  for (const r of resolved) {
    write(`        DATA ls_${r.idLower} TYPE ${r.structureRefLower}.`);
    for (const f of r.fields) {
      writeFieldAssignment(r.idLower, r.nameLower, f.nameLower, f.literal);
    }
    write("");
  }

  write("        DATA lt_mod TYPE /bobf/t_frw_modification.");
  for (const r of resolved) {
    if (!r.parentNameLower) {
      write(`        APPEND VALUE #( node        = ${cif}=>sc_node-${r.nameLower}`);
      write(`                        key         = lv_key_${r.idLower}`);
      write(`                        root_key    = lv_key_${rootIdLower}`);
      write("                        change_mode = /bobf/if_frw_c=>sc_modify_create");
      write(`                        data        = REF #( ls_${r.idLower} ) ) TO lt_mod.`);
    } else {
      write(`        APPEND VALUE #( node        = ${cif}=>sc_node-${r.nameLower}`);
      write(`                        key         = lv_key_${r.idLower}`);
      write(`                        root_key    = lv_key_${rootIdLower}`);
      write(`                        source_node = ${cif}=>sc_node-${r.parentNameLower}`);
      write(`                        source_key  = lv_key_${r.parentIdLower}`);
      write(
        `                        association = ${cif}=>sc_association-${r.parentNameLower}-${r.associationNameLower}`,
      );
      write("                        change_mode = /bobf/if_frw_c=>sc_modify_create");
      write(`                        data        = REF #( ls_${r.idLower} ) ) TO lt_mod.`);
    }
  }
  write("");

  write("        lo_sm->modify( EXPORTING it_modification = lt_mod");
  write(`                       IMPORTING eo_message      = DATA(lo_m${msgN}) ).`);
  emitOut(`STEP${step++} modify() returned without exception`);
  write(`        emit( iv_stage = 'MODIFY' io_msg = lo_m${msgN} ).`);
  msgN++;
  write("");

  write("        DATA lv_rej TYPE boole_d.");
  write("        lo_tm->save( IMPORTING ev_rejected = lv_rej");
  write(`                               eo_message  = DATA(lo_m${msgN}) ).`);
  emitOutTpl(`STEP${step++} save() ev_rejected={ lv_rej }`);
  write(`        emit( iv_stage = 'SAVE' io_msg = lo_m${msgN} ).`);
  msgN++;
  write("");

  // Retrieve the root node's own rows.
  {
    const r = resolved[0]!;
    write(`        DATA lt_${r.idLower} TYPE STANDARD TABLE OF ${r.structureRefLower} WITH EMPTY KEY.`);
    write(`        lo_sm->retrieve( EXPORTING iv_node_key         = ${cif}=>sc_node-${r.nameLower}`);
    write(`                                   it_key              = VALUE #( ( key = lv_key_${r.idLower} ) )`);
    write("                                   iv_invalidate_cache = abap_true");
    write(`                         IMPORTING et_data             = lt_${r.idLower}`);
    write(`                                   eo_message          = DATA(lo_m${msgN}) ).`);
    emitOutTpl(`STEP${step++} retrieve(${r.idLower}) rows={ lines( lt_${r.idLower} ) }`);
    write(`        emit( iv_stage = 'RETRIEVE_${r.idLower.toUpperCase()}' io_msg = lo_m${msgN} ).`);
    msgN++;
    const rowRef = `<row_${r.idLower}>`;
    const linePieces = [
      `${BOPF_LINE_PREFIX}DATA ${r.idLower} key={ ${rowRef}-key }`,
      ...chunkFieldTokens(r.fields, rowRef),
    ];
    write(`        DATA lv_line_${r.idLower} TYPE string.`);
    write(`        LOOP AT lt_${r.idLower} ASSIGNING FIELD-SYMBOL(${rowRef}).`);
    writeLineVar(r.idLower, linePieces);
    write("        ENDLOOP.");
    write("");
  }

  // retrieve_by_association for every non-root node, from its parent.
  for (const r of resolved.slice(1)) {
    write(`        DATA lt_${r.idLower} TYPE STANDARD TABLE OF ${r.structureRefLower} WITH EMPTY KEY.`);
    write("        lo_sm->retrieve_by_association(");
    write(`          EXPORTING iv_node_key    = ${cif}=>sc_node-${r.parentNameLower}`);
    write(`                    it_key         = VALUE #( ( key = lv_key_${r.parentIdLower} ) )`);
    write(
      `                    iv_association = ${cif}=>sc_association-${r.parentNameLower}-${r.associationNameLower}`,
    );
    write("                    iv_fill_data   = abap_true");
    write(`          IMPORTING et_data        = lt_${r.idLower}`);
    write(`                    et_target_key  = DATA(lt_tk_${r.idLower})`);
    write(`                    eo_message     = DATA(lo_m${msgN}) ).`);
    emitOutTpl(
      `STEP${step++} retrieve_by_association(${r.parentIdLower}->${r.idLower}) ` +
        `data_rows={ lines( lt_${r.idLower} ) } target_keys={ lines( lt_tk_${r.idLower} ) }`,
    );
    write(`        emit( iv_stage = 'RBA_${r.idLower.toUpperCase()}' io_msg = lo_m${msgN} ).`);
    msgN++;
    const rowRef = `<row_${r.idLower}>`;
    const linePieces = [
      `${BOPF_LINE_PREFIX}DATA ${r.idLower} key={ ${rowRef}-key }`,
      ...chunkFieldTokens(r.fields, rowRef),
    ];
    write(`        DATA lv_line_${r.idLower} TYPE string.`);
    write(`        LOOP AT lt_${r.idLower} ASSIGNING FIELD-SYMBOL(${rowRef}).`);
    writeLineVar(r.idLower, linePieces);
    write("        ENDLOOP.");
    write("");
  }

  // DB row counts — one SELECT per node that has a persistentTableRef; a
  // pending (absent) tableRef is disclosed, never silently skipped.
  for (const r of resolved) {
    if (r.tableRefLower) {
      write(`        SELECT COUNT(*) FROM ${r.tableRefLower} INTO @DATA(lv_nr_${r.idLower}).`);
      emitOutTpl(`STEP${step++} DBCOUNT ${r.idLower} ${r.tableRefLower}={ lv_nr_${r.idLower} }`);
    } else {
      write(
        `        out->write( '${ERR_LINE_PREFIX}DBCOUNT ${r.idLower} pending — no persistentTableRef ` +
          "in the model (BO not yet fully activated, or this node has no own persistence)' ).",
      );
    }
  }
  write("");

  if (scenario.cleanup) {
    write("        DATA lt_del TYPE /bobf/t_frw_modification.");
    for (const r of resolved) {
      write(`        APPEND VALUE #( node        = ${cif}=>sc_node-${r.nameLower}`);
      write(`                        key         = lv_key_${r.idLower}`);
      write("                        change_mode = /bobf/if_frw_c=>sc_modify_delete ) TO lt_del.");
    }
    write("        lo_sm->modify( EXPORTING it_modification = lt_del");
    write(`                       IMPORTING eo_message      = DATA(lo_m${msgN}) ).`);
    emitOut(`STEP${step++} cleanup modify() returned without exception`);
    write(`        emit( iv_stage = 'CLEANUP_MODIFY' io_msg = lo_m${msgN} ).`);
    msgN++;
    write("");

    write("        DATA lv_rej_cleanup TYPE boole_d.");
    write("        lo_tm->save( IMPORTING ev_rejected = lv_rej_cleanup");
    write(`                               eo_message  = DATA(lo_m${msgN}) ).`);
    emitOutTpl(`STEP${step++} cleanup save() ev_rejected={ lv_rej_cleanup }`);
    write(`        emit( iv_stage = 'CLEANUP_SAVE' io_msg = lo_m${msgN} ).`);
    msgN++;
    write("");
  }

  const bodySrc = body.join("\n");

  const source = `CLASS ${cls} DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.
  PRIVATE SECTION.
    DATA mo_out TYPE REF TO if_oo_adt_classrun_out.
    METHODS emit IMPORTING iv_stage TYPE string
                           io_msg   TYPE REF TO /bobf/if_frw_message.
ENDCLASS.

CLASS ${cls} IMPLEMENTATION.

  METHOD emit.
    IF io_msg IS NOT BOUND.
      mo_out->write( |${BOPF_LINE_PREFIX}MSG { iv_stage } (no message object)| ).
      RETURN.
    ENDIF.
    DATA lt_m TYPE /bobf/t_frw_message_k.
    io_msg->get_messages( IMPORTING et_message = lt_m ).
    IF lt_m IS INITIAL.
      mo_out->write( |${BOPF_LINE_PREFIX}MSG { iv_stage } (0 messages)| ).
      RETURN.
    ENDIF.
    LOOP AT lt_m ASSIGNING FIELD-SYMBOL(<m>).
      DATA lv_txt TYPE string.
      CLEAR lv_txt.
      TRY.
          lv_txt = CAST if_message( <m>-message )->get_text( ).
        CATCH cx_root.
          lv_txt = '<no text>'.
      ENDTRY.
      mo_out->write( |${BOPF_LINE_PREFIX}MSG { iv_stage } SEV={ <m>-severity } { lv_txt }| ).
    ENDLOOP.
  ENDMETHOD.

  METHOD if_oo_adt_classrun~main.
*   Generated by abapsmith. Exercises BO ${boName.toUpperCase()} through a
*   caller-supplied scenario. Do not edit: this class is regenerated from
*   src/adt/bopf-runtime.ts whenever its content hash changes.
    mo_out = out.
    TRY.
${bodySrc}
      CATCH cx_root INTO DATA(lx).
        out->write( |${ERR_LINE_PREFIX}EXCEPTION { cl_abap_classdescr=>get_class_name( lx ) }: { lx->get_text( ) }| ).
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
`;

  // Pre-flight: never hand back source ABAP cannot parse. `body`'s lines
  // start right after the fixed "    TRY." line, so a `body` index maps to
  // the same offset in the final source's line array.
  const sourceLines = source.split("\n");
  const bodyStart = sourceLines.indexOf("    TRY.") + 1;
  for (let i = 0; i < sourceLines.length; i++) {
    const len = sourceLines[i]!.length;
    if (len > MAX_ABAP_LINE) {
      const owner = fieldLineOwners.get(i - bodyStart);
      const detail = owner
        ? `scenario node "${owner.node}" field "${owner.field}"`
        : `first 60 chars: "${sourceLines[i]!.slice(0, 60)}"`;
      throw new AbapError(
        "BAD_INPUT",
        `abap_bopf_test: generated bridge source line ${i + 1} is ${len} characters, over ABAP's ` +
          `255-character limit (${detail}).`,
        { line: i + 1, length: len, node: owner?.node, field: owner?.field },
        "Shorten the value or split the scenario.",
      );
    }
  }

  return source;
}

// ---------------------------------------------------------------------------
// Output parser
// ---------------------------------------------------------------------------

export interface BopfTranscriptMessage {
  stage: string; // "MODIFY" | "SAVE" | "RETRIEVE_<NODE>" | "RBA_<NODE>" | "CLEANUP_MODIFY" | "CLEANUP_SAVE" | ...
  severity?: string; // present when a real message was parsed; absent for the "(no message object)"/"(0 messages)" lines
  text?: string;
}
export interface BopfTranscriptDataRow {
  /** The real BOPF node name (e.g. "root", "item"), never slot-suffixed. */
  node: string;
  /**
   * Zero-based index in `scenario.nodes` (disambiguates repeated node
   * names). `undefined` for a transcript from an older cached bridge class
   * predating slot-keying. Use `node` for comparisons; `formatNodeLabel` to
   * reconstruct the old display label.
   */
  slot?: number;
  fields: Record<string, string>;
}
export interface BopfTranscriptKey {
  /** The real BOPF node name (e.g. "root", "item"), never slot-suffixed. */
  node: string;
  /** See `BopfTranscriptDataRow.slot` — same meaning, same undefined case. */
  slot?: number;
  key: string;
}

/**
 * Split an emitted `DATA`/`KEY` token into node name + slot. Splits on the
 * LAST `_<digits>` (the generator always appends `_${slot}`), so it stays
 * unambiguous even for a node name that itself ends in digits/underscores.
 * No trailing `_<digits>` = backward-compat case (pre-slot-keying cached
 * bridge) — returned whole, `slot` left `undefined`, never invented.
 */
function splitNodeToken(token: string): { node: string; slot?: number } {
  const m = /^(.+)_(\d+)$/.exec(token);
  if (!m) return { node: token };
  return { node: m[1]!, slot: Number(m[2]!) };
}

/**
 * Inverse of `splitNodeToken`. Used by display-only consumers
 * (`src/tools/bopf-test.ts`) so rendered transcripts stay byte-identical.
 */
export function formatNodeLabel(row: { node: string; slot?: number }): string {
  return row.slot === undefined ? row.node : `${row.node}_${row.slot}`;
}
export interface BopfTranscriptResult {
  /** true iff the LAST `ev_rejected=` line seen (create-save, or cleanup-save
   *  when present) reported the single character 'X'. */
  rejected: boolean;
  messages: BopfTranscriptMessage[];
  data: BopfTranscriptDataRow[];
  keys: BopfTranscriptKey[];
  /** ZMCP-ERR> lines, trimmed. Prefix RETAINED — matches `splitBridgeOutput`'s
   *  own `diagnostics` convention (`src/adt/run.ts`) exactly, so a caller that
   *  already knows how to render one knows how to render the other. */
  diagnostics: string[];
  /** Every BOPF>-prefixed line, prefix stripped, in order — the raw transcript. */
  transcript: string[];
  /** Any line matching neither BOPF> nor ZMCP-ERR>, mirroring splitBridgeOutput's discipline. */
  droppedLines: number;
}

/**
 * Parse the raw classrun output of a `bopfBridgeSource`-generated class.
 * Modelled on `splitBridgeOutput` (`src/adt/run.ts`): pass 1 splits into
 * `BOPF>`/`ZMCP-ERR>`/dropped (prefix stripped only — no further trimming,
 * since `ev_rejected=`'s trailing space is meaningful); pass 2 interprets
 * the sub-tags documented above `bopfBridgeSource`. Unrecognised `BOPF>`
 * lines are plain narration, not errors.
 */
export function parseBopfTranscript(raw: string): BopfTranscriptResult {
  const transcript: string[] = [];
  const diagnostics: string[] = [];
  let droppedLines = 0;

  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith(BOPF_LINE_PREFIX)) {
      transcript.push(line.slice(BOPF_LINE_PREFIX.length));
    } else if (line.replace(/\s+$/, "") === BOPF_LINE_PREFIX.trimEnd()) {
      transcript.push(""); // an empty BOPF> line
    } else if (line.startsWith(ERR_LINE_PREFIX)) {
      diagnostics.push(line.trim());
    } else {
      droppedLines++;
    }
  }

  const messages: BopfTranscriptMessage[] = [];
  const data: BopfTranscriptDataRow[] = [];
  const keys: BopfTranscriptKey[] = [];
  let rejected = false;

  const MSG_EMPTY = /^MSG (\S+) \((?:no message object|0 messages)\)$/;
  const MSG_FULL = /^MSG (\S+) SEV=(\S*) (.*)$/;
  const DATA_LINE = /^DATA (\S+) (.+)$/;
  const KEY_LINE = /^KEY (\S+)=(\S+)$/;
  const REJECTED_LINE = /ev_rejected=(.*)$/;
  const PAIR = /(\S+)=(\S*)/g;

  for (const line of transcript) {
    const msgEmpty = MSG_EMPTY.exec(line);
    if (msgEmpty) {
      messages.push({ stage: msgEmpty[1]! });
      continue;
    }
    const msgFull = MSG_FULL.exec(line);
    if (msgFull) {
      messages.push({ stage: msgFull[1]!, severity: msgFull[2], text: msgFull[3] });
      continue;
    }
    const dataLine = DATA_LINE.exec(line);
    if (dataLine) {
      const fields: Record<string, string> = {};
      PAIR.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PAIR.exec(dataLine[2]!))) fields[m[1]!] = m[2]!;
      data.push({ ...splitNodeToken(dataLine[1]!), fields });
      continue;
    }
    const keyLine = KEY_LINE.exec(line);
    if (keyLine) {
      keys.push({ ...splitNodeToken(keyLine[1]!), key: keyLine[2]! });
      continue;
    }
    const rej = REJECTED_LINE.exec(line);
    if (rej) {
      // Last one wins: a cleanup save (when present) is the last mutating
      // thing that happens, and the caller cares whether the run ended clean.
      rejected = rej[1] === "X";
      continue;
    }
    // Plain narration — present in `transcript`, contributes nothing else.
  }

  return { rejected, messages, data, keys, diagnostics, transcript, droppedLines };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunBopfTestOptions {
  /** write+activate the bridge, never call runClass. */
  generateOnly?: boolean;
}

export interface BopfTestResult {
  bo: string;
  version?: string;
  bridgeClass: string;
  bridgeRefreshed: boolean;
  constantsInterface: string;
  durationMs: number;
  generateOnly: boolean;
  // Present only when generateOnly is false — a run actually happened:
  rejected?: boolean;
  /** Count of parsed messages whose severity is "E" or "A" (error/abort). */
  errors?: number;
  /** Count of parsed messages whose severity is "W" (warning). */
  warnings?: number;
  /** keys.length — the number of GUIDs the run minted and reported creating. */
  rowsWritten?: number;
  transcript?: BopfTranscriptResult;
  outputComplete?: boolean;
  bodyBytes?: number;
}

/**
 * Generate/refresh the BOPF test bridge, activate it, then (unless
 * `generateOnly`) run it in a fresh session and parse its transcript.
 *
 * Follows `run.ts`'s shared bridge choreography (`deployBridge` then
 * `executeBridge`): activation is unconditional regardless of
 * `write.changed` (a `changed: false` read can still be the inactive
 * version). `generateOnly` returns after deploy without executing — this is
 * what lets `abap_debug` set a breakpoint and trigger the run separately.
 */
export async function runBopfTest(
  conn: AbapConnection,
  model: BoModel,
  scenario: BopfTestScenario,
  gate: SafetyGate,
  opts?: RunBopfTestOptions,
): Promise<BopfTestResult> {
  const started = Date.now();
  const className = bopfBridgeClassName(model.name);
  const source = bopfBridgeSource(model, scenario, className);

  const deployed = await deployBridge(conn, gate, {
    className,
    source,
    description: `abapsmith BOPF test bridge for ${model.name}`,
    caller: { tool: "abap_bopf_test", action: "run_test" },
    what: "Activation of the generated BOPF test bridge",
    hint:
      `The bridge exercises BO ${model.name} through its service/transaction managers, so ` +
      "the usual cause is that the BO is inactive, does not exist, or a scenario node's " +
      "structure reference no longer matches what activated.",
    verify: (activation) =>
      verifyBridgeActivation(activation, className, "BOPF test bridge", { bo: model.name }),
  });
  const { bridgeRefreshed } = deployed;

  if (opts?.generateOnly) {
    return {
      bo: model.name,
      version: model.version,
      bridgeClass: className,
      bridgeRefreshed,
      constantsInterface: constantsInterfaceName(model),
      durationMs: Date.now() - started,
      generateOnly: true,
    };
  }

  // Distinct mutating operation from write/activate above — gated
  // separately as "execute".
  const run = await executeBridge(conn, gate, deployed);
  const transcript = parseBopfTranscript(run.output);
  const errors = transcript.messages.filter((m) => m.severity === "E" || m.severity === "A").length;
  const warnings = transcript.messages.filter((m) => m.severity === "W").length;

  return {
    bo: model.name,
    version: model.version,
    bridgeClass: className,
    bridgeRefreshed,
    constantsInterface: constantsInterfaceName(model),
    durationMs: Date.now() - started,
    generateOnly: false,
    rejected: transcript.rejected,
    errors,
    warnings,
    rowsWritten: transcript.keys.length,
    transcript,
    outputComplete: run.outputComplete,
    bodyBytes: run.bodyBytes,
  };
}
