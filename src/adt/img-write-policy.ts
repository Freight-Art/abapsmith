/**
 * Pure refusal policy for `abap_img_edit` (modes `preview`/`upsert`/`delete`).
 * No I/O, no connection, no gate mutation: this takes what the write bridge
 * has already read — the resolved table's DDIC shape, the recalled
 * T000-CCCORACTIV client setting, the caller's own arguments — and turns it
 * into allow-or-refuse. It lives apart from `src/safety.ts`'s object gate
 * because every rule here is about IMG customizing ROWS on a table the
 * caller does not name directly (an activity resolves to one), which that
 * gate has no vocabulary for; widening it would blur the two.
 *
 * Evaluated in strict order — the first failing rule wins, and its message
 * is the reason quoted back to the caller. `preview` runs every rule but
 * turns 12-14 (corr_nr and confirm — nothing to require or confirm when
 * nothing is being written) into advisory notes instead of a refusal, so a
 * consultant previewing a change sees in advance what `upsert`/`delete` will
 * demand.
 */
import type { SafetyConfig } from "../safety.js";
import { isPreviewTableDenied } from "../safety.js";

export const IMG_MAX_ROWS = 50;

export interface PolicyField {
  readonly field: string;
  readonly dataType: string;
  readonly key: boolean;
}

export interface PolicyTable {
  readonly table: string;
  readonly clientDependent: boolean;
  /** DD02L-CONTFLAG as read; `""` when the delivery class could not be determined. */
  readonly deliveryClass: string;
  readonly fields: readonly PolicyField[];
}

export interface ImgWriteProbe {
  readonly table: PolicyTable;
  readonly targetKind: "view" | "cluster" | "table" | "other";
  /** Set when the activity resolved to more than one candidate. */
  readonly ambiguity?: string;
  /** T000-CCCORACTIV exactly as read; undefined when it was not read at all. */
  readonly cccoractiv?: string;
}

export interface ImgWriteRequest {
  readonly mode: "preview" | "upsert" | "delete";
  readonly rows: readonly Readonly<Record<string, string>>[];
  readonly corrNr?: string;
  readonly confirm?: string;
  readonly allowCrossClient?: boolean;
}

export type ImgWriteVerdict =
  | { readonly allowed: true; readonly notes: readonly string[] }
  | { readonly allowed: false; readonly rule: string; readonly reason: string };

export interface EvaluateImgWriteOptions {
  readonly previewDenyExtra?: readonly string[];
}

function refuse(rule: string, reason: string): ImgWriteVerdict {
  return { allowed: false, rule, reason };
}

/** Delivery classes this tool will write to: customizing data, meant to be changed by an implementation. */
const WRITABLE_DELIVERY_CLASSES: ReadonlySet<string> = new Set(["C", "G", "E"]);

/** What a denied delivery class actually is, quoted into the refusal so the reader learns the class of table they hit, not just that it failed. */
const DELIVERY_CLASS_DENIALS: Readonly<Record<string, string>> = {
  A: "application table — master and transaction data, not customizing",
  L: "temporary/work table — not the table the application actually reads at runtime",
  S: "system table — owned and maintained by SAP",
  W: "system table for repository and CTS objects — part of the transport/repository infrastructure itself",
};

/** Key-field data types `ASSIGN ... CASTING TYPE c` can safely address — see the comment on the rule-10 check below. */
const CHAR_LIKE_KEY_TYPES: ReadonlySet<string> = new Set([
  "CLNT",
  "CHAR",
  "NUMC",
  "LANG",
  "UNIT",
  "CUKY",
  "DATS",
  "TIMS",
  "ACCP",
]);

/**
 * `corr_nr` normalisation: blank or all-whitespace means "named nothing",
 * same convention `safety.ts`'s own `normalizeCorrNr` applies to every
 * transport-bearing tool. Duplicated here (rather than imported) because
 * this module may import only types and `isPreviewTableDenied` from that file.
 */
function normalizedCorrNr(corrNr: string | undefined): string | undefined {
  const trimmed = corrNr?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

type CccoractivState = "auto-record" | "blocked" | "off" | "unknown";

/**
 * T000-CCCORACTIV, recalled from a prior probe and NOT re-verified here —
 * this module does no I/O, so a value going stale between the probe and this
 * call (someone flips the client's Change Options mid-session) is a risk the
 * caller, not this function, must manage. '1' = automatic recording of
 * changes; '2' = client-dependent customizing blocked outright in this
 * client; blank = changes allowed without automatic recording. An
 * unrecognised value, and an unread one, is treated as the conservative case
 * (recording required) rather than guessed open.
 */
function classifyCccoractiv(raw: string | undefined): CccoractivState {
  if (raw === undefined) return "unknown";
  const trimmed = raw.trim();
  if (trimmed === "") return "off";
  if (trimmed === "1") return "auto-record";
  if (trimmed === "2") return "blocked";
  return "unknown";
}

function describeCccoractiv(raw: string | undefined): string {
  if (raw === undefined) return "not read";
  const trimmed = raw.trim();
  return trimmed === "" ? '"" (blank)' : `"${trimmed}"`;
}

export function evaluateImgWrite(
  probe: ImgWriteProbe,
  req: ImgWriteRequest,
  cfg: Readonly<SafetyConfig>,
  opts?: EvaluateImgWriteOptions,
): ImgWriteVerdict {
  // ---- Rule 1: productive system — un-overridable, mirrors evaluate()'s own first check. ----
  if (cfg.productive === true || cfg.systemRole === "productive") {
    return refuse(
      "productive-system",
      "This system reports itself as productive. IMG customizing writes are refused on a " +
        "productive system with no override — no flag or mode value changes this.",
    );
  }

  // ---- Rule 2: write lockout. `true` OR still `undefined` both refuse: nothing has yet proven
  // this system non-productive, and treating "not proven" as "fine" would be exactly the fail-open
  // the tri-state role probe exists to prevent — see evaluateDataPreview's own stricter handling
  // of the unset case in safety.ts, which this mirrors. ----
  if (cfg.writesLockedOut === true || cfg.writesLockedOut === undefined) {
    const evidence =
      cfg.lockoutReason ?? "No system-role probe has confirmed this system is non-productive yet.";
    return refuse(
      "write-lockout",
      `IMG customizing writes are locked out: ${evidence} No flag, allowlist or ABAP_MODE value ` +
        "overrides this — it clears only once the system-role probe proves the system non-productive.",
    );
  }

  // ---- Rule 3: read-only ----
  if (cfg.readOnly === true) {
    return refuse(
      "read-only",
      "This server is running read-only, so no IMG customizing write can be made here. Ask the " +
        "operator to enable writes if this system is meant to accept them.",
    );
  }

  // ---- Rule 4: ambiguity. Runs before any rule below that treats probe.table as a settled fact —
  // an ambiguous activity has no single table to judge, so a delivery-class/key-field/etc verdict
  // on one candidate would misdiagnose the actual problem. ----
  if (probe.ambiguity !== undefined) {
    return refuse(
      "ambiguous-target",
      `This IMG activity resolved to more than one candidate: ${probe.ambiguity} Pass the view or ` +
        "table name explicitly instead of the activity, so there is exactly one target to judge.",
    );
  }

  // ---- Rule 5: target kind. Also ahead of the table-dependent rules below, for the same reason —
  // a target this tool cannot maintain at all makes a delivery-class complaint about its table noise. ----
  if (probe.targetKind === "other") {
    return refuse(
      "target-kind",
      "This IMG activity resolves to a target this tool does not recognise as writable. Only a " +
        "maintenance view, a view cluster or a transparent table can be written here.",
    );
  }

  const table = probe.table;

  // ---- Rule 6: delivery class ----
  const deliveryClass = table.deliveryClass.trim().toUpperCase();
  if (!WRITABLE_DELIVERY_CLASSES.has(deliveryClass)) {
    const reason =
      deliveryClass === ""
        ? `Table ${table.table}'s delivery class could not be determined, so this write is refused: ` +
          "only customizing tables (delivery class C, G or E) may be changed here."
        : `Table ${table.table} has delivery class ${deliveryClass} ` +
          `(${DELIVERY_CLASS_DENIALS[deliveryClass] ?? "not a recognised customizing class"}), which this ` +
          "tool will not write to. Only delivery class C (customizing), G (customizing, protected against " +
          "SAP overwrite) or E (control table, SAP and customer key ranges) may be written here.";
    return refuse("delivery-class", reason);
  }

  // ---- Rule 7: cross-client ----
  if (table.clientDependent === false && req.allowCrossClient !== true) {
    return refuse(
      "cross-client",
      `Table ${table.table} is client-independent: this change would affect every client on the ` +
        "system, not just the one you are logged into. Pass allowCrossClient: true once you have " +
        "confirmed that is intended.",
    );
  }

  // ---- Rule 8: data-preview deny-list — a table this server refuses to read must not be written either. ----
  const denied = isPreviewTableDenied(table.table, opts?.previewDenyExtra);
  if (denied.denied) {
    const rule = denied.rule;
    const detail = rule ? ` (${rule.kind} rule "${rule.value}"): ${rule.reason}` : ".";
    return refuse(
      "preview-deny-list",
      `Table ${table.table} is on the data-preview deny-list${detail} A table this server refuses ` +
        "to read is refused to write as well.",
    );
  }

  // ---- Rule 9: row count ----
  if (req.rows.length === 0) {
    return refuse("row-count", "No rows were supplied, so there is nothing to write.");
  }
  if (req.rows.length > IMG_MAX_ROWS) {
    return refuse(
      "row-count",
      `${req.rows.length} rows were supplied, more than the ${IMG_MAX_ROWS}-row limit for one call. ` +
        `Split the change into batches of at most ${IMG_MAX_ROWS} rows.`,
    );
  }

  // ---- Rule 10: non-character key fields. The transport key (E071K-TABKEY) is built in ABAP with
  // `ASSIGN ls_key TO <lv_key> CASTING TYPE c` over a key structure typed off the table — sound only
  // when every key component is character-like, which is what this checks. ----
  for (const field of table.fields) {
    if (!field.key) continue;
    const dataType = field.dataType.trim().toUpperCase();
    if (!CHAR_LIKE_KEY_TYPES.has(dataType)) {
      return refuse(
        "key-field-type",
        `Key field ${field.field} on ${table.table} has data type ${field.dataType}, which is not ` +
          "one of the character-like types this tool can key on (CLNT, CHAR, NUMC, LANG, UNIT, CUKY, " +
          "DATS, TIMS, ACCP). Maintain this table through a transaction that can handle a non-character key instead.",
      );
    }
  }

  // ---- Rule 11: CCCORACTIV outright block — see classifyCccoractiv's own comment on staleness. ----
  const cccoractiv = classifyCccoractiv(probe.cccoractiv);
  if (cccoractiv === "blocked") {
    return refuse(
      "cccoractiv",
      'T000-CCCORACTIV = "2" for this client: changes to client-dependent customizing are not ' +
        "permitted in this client at all. This is a client setting (Client Change Options), not " +
        "something a transport request or a flag on this call can override.",
    );
  }

  // ---- Rules 12-14: corr_nr and confirm. Enforced for upsert/delete; for preview, turned into
  // advisory notes since nothing is actually being written yet. ----
  const notes: string[] = [
    "This write does not run the target view's own table-maintenance event modules (PBO/PAI, F4 " +
      "checks, consistency checks) — only the row data is written, so validation the SM30 dialog " +
      "would have performed did not happen here.",
  ];

  const recordingProvenOff = cccoractiv === "off";
  const corrRequired = !(table.clientDependent === true && recordingProvenOff);
  const namedCorrNr = normalizedCorrNr(req.corrNr);

  const corrNrMissingMessage =
    corrRequired && namedCorrNr === undefined
      ? `No corr_nr was supplied. A transport request is required here because ${
          table.clientDependent === false
            ? "the table is client-independent"
            : "automatic recording is not confirmed to be switched off for this client " +
              `(T000-CCCORACTIV read as ${describeCccoractiv(probe.cccoractiv)})`
        }.`
      : undefined;

  if (corrNrMissingMessage) {
    if (req.mode !== "preview") return refuse("corr-nr-required", corrNrMissingMessage);
    notes.push(`Applying this change would refuse unless a transport request is supplied: ${corrNrMissingMessage}`);
  }

  let corrNrDeniedMessage: string | undefined;
  if (namedCorrNr !== undefined) {
    // Mirrors safety.ts's `allowTransports` semantics: unset ⇒ any (`["*"]`), an explicitly empty
    // list ⇒ deny-all, `"*"` ⇒ any, otherwise an exact uppercase match against the list.
    const allowlist = cfg.allowTransports ?? ["*"];
    if (allowlist.length === 0) {
      corrNrDeniedMessage =
        "The transport allowlist is configured as deny-all (an explicitly empty list), so no " +
        "transport request may be used for this write.";
    } else {
      const normalized = allowlist.map((t) => t.trim().toUpperCase());
      if (!normalized.includes("*") && !normalized.includes(namedCorrNr.toUpperCase())) {
        corrNrDeniedMessage =
          `Transport ${namedCorrNr} is not permitted by the configured transport allowlist ` +
          `[${allowlist.join(", ")}]. Use one of the allowed requests, or ask the operator to widen it.`;
      }
    }
  }
  if (corrNrDeniedMessage) {
    if (req.mode !== "preview") return refuse("corr-nr-not-allowed", corrNrDeniedMessage);
    notes.push(`Applying this change would refuse: ${corrNrDeniedMessage}`);
  }

  const baseTable = table.table.trim();
  if (req.mode === "upsert" || req.mode === "delete") {
    const confirmed = (req.confirm ?? "").trim();
    if (confirmed.toUpperCase() !== baseTable.toUpperCase()) {
      return refuse(
        "confirm-mismatch",
        `To ${req.mode} rows in ${baseTable}, pass confirm: "${baseTable}" — the name of the base ` +
          "table that will actually change, not the IMG activity or the view you navigated through.",
      );
    }
  } else {
    notes.push(
      `Applying this change would require confirm: "${baseTable}" (the base table's own name, not the activity or view).`,
    );
  }

  if (req.mode === "preview") {
    notes.push("This was a preview: rows were validated but nothing was written.");
  }

  return { allowed: true, notes };
}
