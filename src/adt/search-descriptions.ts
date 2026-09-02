/**
 * ADT's quickSearch mis-pairs `adtcore:description` within a type group (the
 * part before `/`, e.g. TABL): rows are emitted ordered by (sub-type, name),
 * but descriptions are zipped on in that same group's name-ascending order
 * (e.g. DD02T covers both TABL/DT and TABL/DS). The repair restores the
 * pairing by re-sorting the group by name and re-applying wire-order
 * descriptions positionally. Row order is never changed, only descriptions.
 *
 * Nothing in the response ties a description to its row, so this rule is
 * validated against ground-truth per-object reads, not proven by the payload
 * — and it is not universal: FUGR meets the same ordering precondition yet
 * its wire descriptions are already correct (function-module short texts sit
 * in a table separate from FUGR's own), so the precondition alone can't tell
 * FUGR apart from TABL/PROG — hence KNOWN_CLEAN_GROUPS below. See fixtures
 * 451, 812, 820-825, 829-843.
 */

export interface SearchRef {
  readonly "adtcore:type"?: string;
  readonly "adtcore:name"?: string;
  readonly "adtcore:description"?: string;
}

export interface RepairedSearch<T extends SearchRef> {
  readonly refs: readonly T[];
  readonly repairedGroups: readonly string[];
  readonly suspectGroups: readonly string[];
}

/** Type groups proven (by capture plus per-object ground-truth reads) to
 *  arrive mis-paired. TABL: fixtures 451/812/822/836, ground truth 814-817 and
 *  837-843 (e.g. T000 = "Clients", not the wire value). PROG: fixture 824
 *  (14-row PROG/P + PROG/I group), ground truth 829-831. Widening this set
 *  needs the same: a capture plus per-object reads showing the wire value is
 *  wrong — not an argument that it should be. */
const VERIFIED_GROUPS = new Set(["TABL", "PROG"]);

/** Type groups proven, not merely assumed, to arrive already correct — so
 *  they must be excluded even though they pass wireOrderMatchesModel. FUGR:
 *  fixtures 824 (8 rows) and 825 (59 rows) both satisfy the ordering
 *  precondition and would be "repaired" by it, but ground truth 832-834 shows
 *  the wire values are already right (function-module short texts live in a
 *  table separate from FUGR's own, so there is no shared zip to undo). A FUGR
 *  group must be neither repaired nor reported suspect — reporting it suspect
 *  would be a false alarm about data already proven clean. */
const KNOWN_CLEAN_GROUPS = new Set(["FUGR"]);

const typeGroupOf = (r: SearchRef): string => (r["adtcore:type"] ?? "").split("/")[0]!.toUpperCase();

const byNameAscending = (a: SearchRef, b: SearchRef): number => {
  const [x, y] = [a["adtcore:name"] ?? "", b["adtcore:name"] ?? ""];
  return x < y ? -1 : x > y ? 1 : 0;
};

// The defect model predicts rows arrive ordered by (full type, name). If a
// group's wire order does not match that, the model does not apply to it —
// repairing anyway would just produce a different, unverifiable permutation.
const wireOrderMatchesModel = (entries: { ref: SearchRef }[]): boolean =>
  entries.every((entry, i) => {
    if (i === 0) return true;
    const prevType = (entries[i - 1]!.ref["adtcore:type"] ?? "").toUpperCase();
    const type = (entry.ref["adtcore:type"] ?? "").toUpperCase();
    if (prevType !== type) return prevType <= type;
    const prevName = (entries[i - 1]!.ref["adtcore:name"] ?? "").toUpperCase();
    const name = (entry.ref["adtcore:name"] ?? "").toUpperCase();
    return prevName <= name;
  });

export function repairSearchDescriptions<T extends SearchRef>(refs: readonly T[]): RepairedSearch<T> {
  const groups = new Map<string, { index: number; ref: T }[]>();
  refs.forEach((ref, index) => {
    const key = typeGroupOf(ref);
    const bucket = groups.get(key);
    if (bucket) bucket.push({ index, ref });
    else groups.set(key, [{ index, ref }]);
  });

  const out = refs.slice();
  const repairedGroups = new Set<string>();
  const suspectGroups = new Set<string>();

  for (const [key, entries] of groups) {
    if (KNOWN_CLEAN_GROUPS.has(key)) continue;
    const distinctTypes = new Set(entries.map((e) => e.ref["adtcore:type"] ?? ""));
    if (distinctTypes.size < 2) continue;
    if (entries.some((e) => !e.ref["adtcore:description"])) continue;
    if (!wireOrderMatchesModel(entries)) continue;

    const wireDescriptions = entries.map((e) => e.ref["adtcore:description"]!);
    const byName = entries.slice().sort((a, b) => byNameAscending(a.ref, b.ref));
    const permutation = byName.map((entry, i) => ({ entry, description: wireDescriptions[i]! }));
    const changed = permutation.some(({ entry, description }) => description !== entry.ref["adtcore:description"]);
    if (!changed) continue;

    if (!VERIFIED_GROUPS.has(key)) {
      suspectGroups.add(key);
      continue;
    }
    for (const { entry, description } of permutation) {
      out[entry.index] = { ...entry.ref, "adtcore:description": description };
    }
    repairedGroups.add(key);
  }

  return { refs: out, repairedGroups: [...repairedGroups].sort(), suspectGroups: [...suspectGroups].sort() };
}
