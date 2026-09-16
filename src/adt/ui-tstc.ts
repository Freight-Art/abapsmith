/**
 * TSTC pre-check for `abap_ui` (issue #150).
 *
 * Every tcode-addressed `abap_ui` call used to learn that a transaction does
 * not exist only from the fluid bridge: the invoker class is content-hashed
 * over its arguments, so each new tcode deploys + activates a new
 * `ZCL_ZMCP_I_<hash>` (about 20 s on the A4H appliance) before the ABAP
 * `SELECT SINGLE ... FROM tstc` fails and comes back as a
 * `FLUID_ACTION_FAILED` "TSTC lookup failed". This module asks TSTC through
 * the existing catalog select path instead — one
 * `POST /sap/bc/adt/datapreview/freestyle` (about 1 s), no class deployed,
 * nothing executed — so the tool layer can refuse with a structured
 * `NOT_FOUND` before any bridge work starts.
 *
 * The query is `buildTransactionDetailQuery` (src/adt/catalog-query.ts), the
 * same statement `abap_read` uses for `TRAN/T`; the row also carries CINFO,
 * which is what `press` needs for its batch-input applicability check, so
 * press no longer runs a whole screen-mode bridge just to read that one
 * byte.
 *
 * `kind` strings mirror `resolve_target` in src/adt/fluid/builtin/ui.ts
 * verbatim so a caller sees the same wording whether the record came from
 * this pre-check or from the bridge's own TCODE line.
 */
import type { AbapConnection } from "./connection.js";
import { buildTransactionDetailQuery } from "./catalog-query.js";
import { runCatalogSelect } from "./catalog-select.js";

/** One TSTC row, in the shape `UiTranscriptResult.tcode` already uses (src/adt/ui-runtime.ts). */
export interface UiTstcRecord {
  readonly tcode: string;
  readonly program: string;
  readonly dynpro: string;
  readonly cinfo: string;
  readonly kind: string;
  /** true = '00' (dialog, batch input applies); false = '80' (report); undefined = anything else (not confirmed). */
  readonly bdcApplies: boolean | undefined;
}

/** Same three strings `resolve_target` emits in src/adt/fluid/builtin/ui.ts. */
export function tstcKind(cinfo: string): string {
  switch (cinfo) {
    case "00":
      return "dialog transaction (classic dynpro; batch input / press applies)";
    case "80":
      return "report transaction (SUBMIT-driven; batch input does NOT apply)";
    default:
      return "unrecognised transaction kind - mechanism not confirmed, do not assume batch input applies";
  }
}

/**
 * Reads `tcode`'s TSTC row through the catalog select path. Returns
 * `undefined` when TSTC has no such row — the caller decides how to refuse.
 * Exactly one wire request (`dataPreviewFreestyle`), never a bridge deploy.
 * A malformed tcode is refused by `assertTransactionCode` inside the query
 * builder before anything is sent.
 */
export async function lookupTransaction(conn: AbapConnection, tcode: string): Promise<UiTstcRecord | undefined> {
  const result = await runCatalogSelect(conn, buildTransactionDetailQuery(tcode), 1);
  const row = result.rows[0];
  if (!row) return undefined;
  const cinfo = (row.CINFO ?? "").trim();
  return {
    tcode: (row.TCODE ?? tcode).trim(),
    program: (row.PGMNA ?? "").trim(),
    dynpro: (row.DYPNO ?? "").trim(),
    cinfo,
    kind: tstcKind(cinfo),
    bdcApplies: cinfo === "00" ? true : cinfo === "80" ? false : undefined,
  };
}
