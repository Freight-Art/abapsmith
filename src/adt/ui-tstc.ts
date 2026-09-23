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
 * `kindCode` is derived from CINFO's bits (see {@link tstcKind}), not a
 * two-value switch: CINFO is a bitfield (0x80 report, 0x08 OO, 0x02
 * parameter/variant/OO-with-model — details live in TSTCP, see
 * `./catalog-query.ts`'s `parseTransactionParameters` — 0x01 area menu,
 * else dialog); `kind` is `kindCode`'s human-readable text. `bdcApplies`
 * keeps its old, narrower meaning: `true` only for CINFO `"00"`, `false`
 * only for `kindCode === "report"`.
 */
import type { AbapConnection } from "./connection.js";
import { buildTransactionDetailQuery } from "./catalog-query.js";
import { runCatalogSelect } from "./catalog-select.js";

/** `tstcKind`'s bit-derived transaction kind. */
export type UiTstcKind = "dialog" | "report" | "parameter" | "oo" | "menu";

const KIND_TEXT: Record<UiTstcKind, string> = {
  dialog: "dialog transaction (classic dynpro; batch input / press applies)",
  report: "report transaction (SUBMIT-driven; batch input does NOT apply)",
  parameter: "parameter/variant transaction (TSTCP-driven; batch input does NOT apply to it directly)",
  oo: "OO transaction (class method; batch input does NOT apply)",
  menu: "area menu (batch input does NOT apply)",
};

/** One TSTC row, in the shape `UiTranscriptResult.tcode` already uses (src/adt/ui-runtime.ts). */
export interface UiTstcRecord {
  readonly tcode: string;
  readonly program: string;
  readonly dynpro: string;
  readonly cinfo: string;
  /** Bit-derived kind, machine-readable — see {@link tstcKind}. */
  readonly kindCode: UiTstcKind;
  /** `kindCode`'s human-readable text, printed to users by `src/tools/ui.ts`. */
  readonly kind: string;
  /** true only for CINFO `"00"` (batch input / press applies); false only for `kindCode === "report"`; undefined otherwise. */
  readonly bdcApplies: boolean | undefined;
}

/**
 * `TSTC-CINFO` is a bitfield, not an enum — read it that way rather than by
 * exact-string match. Bits, high to low: `0x80` report (SUBMIT-driven),
 * `0x10` report-with-variant (OR'd onto `0x80`), `0x08` OO transaction
 * (without transaction model — no SAP API to write one, see
 * `./tran-create.ts`'s header), `0x04` aut, `0x02` parameter, variant, or OO
 * with transaction model (which of the three is in TSTCP — see
 * `./catalog-query.ts`'s `parseTransactionParameters`), `0x01` area menu,
 * `0x20` lock. Everything else (notably `00`) is a plain dialog transaction.
 */
export function tstcKind(cinfo: string): UiTstcKind {
  const bits = parseInt(cinfo, 16);
  if (Number.isNaN(bits)) return "dialog";
  if (bits & 0x80) return "report";
  if (bits & 0x08) return "oo";
  if (bits & 0x02) return "parameter";
  if (bits & 0x01) return "menu";
  return "dialog";
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
  // A response that never even carries the TCODE column is not a TSTC row
  // (e.g. a wrongly-shaped/error body) — treated the same as "no row", per
  // this function's own contract, rather than fabricated into a fake record.
  if (!result.columns.includes("TCODE")) return undefined;
  const row = result.rows[0];
  if (!row) return undefined;
  const cinfo = (row.CINFO ?? "").trim();
  const kindCode = tstcKind(cinfo);
  return {
    tcode: (row.TCODE ?? tcode).trim(),
    program: (row.PGMNA ?? "").trim(),
    dynpro: (row.DYPNO ?? "").trim(),
    cinfo,
    kindCode,
    kind: KIND_TEXT[kindCode],
    bdcApplies: cinfo === "00" ? true : kindCode === "report" ? false : undefined,
  };
}
