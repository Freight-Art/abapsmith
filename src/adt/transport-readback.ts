/**
 * Read-back confirmation for a bridge write's resolved transport request.
 *
 * `resolveBridgeCreateCorr` (`src/tools/write-bridge-common.ts`) picks a `corrNr` before the
 * write happens; it never confirms CTS actually recorded the object there.
 * This module does that confirmation, after the fact, for the classic-bridge
 * creates (`VIEW/DV`, `TRAN/T`, `TABL/DI`) that have no ADT lock response to
 * read the recorded request off of.
 *
 * Never throws: any wire failure collapses to `status: "unknown"` with a
 * reason naming the step that failed, so a read-back problem never masks a
 * successful create.
 */
import type { AbapConnection } from "./connection.js";
import { trRequirement, trShow, type TrHeader, type TrObject } from "./transports.js";

/** Identity of one object row on a transport request (`pgmid`/`type`/`name`). */
export interface TrEntryKey {
  readonly pgmid: string;
  readonly type: string;
  readonly name: string;
}

/** What to look for, and where, when confirming a bridge write's transport. */
export interface TrReadbackTarget {
  /** The request number the write sent. */
  readonly intended: string;
  /** The entry the write is expected to have recorded, e.g. `{LIMU, INDX, "ZAS_T173 Z01"}`. */
  readonly entry: TrEntryKey;
  /** An entry whose presence also proves `entry` is covered, e.g. the base table's `{R3TR, TABL, ...}`. */
  readonly covering?: TrEntryKey;
  /** A transportchecks target used to ask CTS where the object is locked, when `intended` doesn't list it. */
  readonly lookup?: { readonly uri: string; readonly devclass: string };
}

export type TrReadback =
  | { readonly status: "confirmed-same"; readonly trkorr: string; readonly matched: TrEntryKey }
  | {
      readonly status: "confirmed-other";
      readonly trkorr: string;
      readonly intended: string;
      readonly holder: TrHeader;
      readonly matched: TrEntryKey;
    }
  | { readonly status: "unknown"; readonly reason: string; readonly entry: TrEntryKey };

/** `"LIMU INDX ZAS_T173 Z01"` — upper-cased, runs of whitespace in the name collapsed to one space. */
export function entryLabel(k: TrEntryKey): string {
  const name = k.name.trim().replace(/\s+/g, " ").toUpperCase();
  return `${k.pgmid.trim().toUpperCase()} ${k.type.trim().toUpperCase()} ${name}`;
}

/** `pgmid`/`type` compared case-insensitively; `name` with ALL whitespace stripped, case-insensitive. */
export function sameEntry(a: TrEntryKey, b: TrEntryKey): boolean {
  const upper = (s: string) => s.trim().toUpperCase();
  const stripped = (s: string) => s.replace(/\s+/g, "").toUpperCase();
  return upper(a.pgmid) === upper(b.pgmid) && upper(a.type) === upper(b.type) && stripped(a.name) === stripped(b.name);
}

function findMatch(
  objects: readonly TrObject[],
  entry: TrEntryKey,
  covering: TrEntryKey | undefined,
): TrEntryKey | undefined {
  if (objects.some((o) => sameEntry(o, entry))) return entry;
  if (covering !== undefined && objects.some((o) => sameEntry(o, covering))) return covering;
  return undefined;
}

function unknown(reason: string, entry: TrEntryKey): TrReadback {
  return { status: "unknown", reason, entry };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Confirms which request actually holds `target.entry` (or `target.covering`),
 * after a bridge write sent `target.intended`.
 *
 * 1. Re-read `intended`; if it lists the entry (or covering), `confirmed-same`.
 * 2. Else, if `lookup` was given, ask `trRequirement` who now holds the lock. A
 *    different holder that lists the entry (or covering) is `confirmed-other`.
 *    A different holder that lists neither is `unknown`.
 * 3. Otherwise `unknown` — `intended` doesn't list the entry and CTS named no
 *    other holder (or the holder found is `intended` itself).
 *
 * Never throws — any wire failure at any step becomes `unknown`.
 */
export async function readBackTransportEntry(
  conn: AbapConnection,
  target: TrReadbackTarget,
  cts: { trShow: typeof trShow; trRequirement: typeof trRequirement } = { trShow, trRequirement },
): Promise<TrReadback> {
  const { intended, entry, covering, lookup } = target;

  let req;
  try {
    req = await cts.trShow(conn, intended);
  } catch (err) {
    return unknown(`reading back request ${intended} failed: ${message(err)}`, entry);
  }
  const ownMatch = findMatch(req.objects, entry, covering);
  if (ownMatch !== undefined) {
    return { status: "confirmed-same", trkorr: intended, matched: ownMatch };
  }

  let holderNr: string | undefined;
  if (lookup !== undefined) {
    let chk;
    try {
      chk = await cts.trRequirement(conn, lookup.uri, lookup.devclass, "U");
    } catch (err) {
      return unknown(`checking the current lock holder for ${lookup.uri} failed: ${message(err)}`, entry);
    }
    holderNr = (chk.pinnedTo?.trim() || chk.locks[0]?.request.trkorr) ?? undefined;
  }

  if (holderNr !== undefined && holderNr !== "" && holderNr.toUpperCase() !== intended.toUpperCase()) {
    let holder;
    try {
      holder = await cts.trShow(conn, holderNr);
    } catch (err) {
      return unknown(`reading back lock holder ${holderNr} failed: ${message(err)}`, entry);
    }
    const holderMatch = findMatch(holder.objects, entry, covering);
    if (holderMatch !== undefined) {
      return { status: "confirmed-other", trkorr: holderNr, intended, holder, matched: holderMatch };
    }
    return unknown(
      `CTS reports the lock in ${holderNr} but ${holderNr} lists neither ${entryLabel(entry)}` +
        `${covering !== undefined ? ` nor ${entryLabel(covering)}` : ""}.`,
      entry,
    );
  }

  return unknown(
    `request ${intended} does not list ${entryLabel(entry)}` +
      `${covering !== undefined ? ` or ${entryLabel(covering)}` : ""}` +
      (lookup === undefined
        ? ""
        : holderNr === undefined || holderNr === ""
          ? " and CTS reported no lock holder"
          : ` although CTS reports the lock in ${holderNr}`),
    entry,
  );
}
