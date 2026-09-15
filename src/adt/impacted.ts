/**
 * Impacted-test selection (issue #111): given a set of changed objects,
 * decide which test carriers a change puts at risk and should be re-run.
 *
 * Pure and injectable — this module makes no ADT call itself. `whereUsed`
 * and `probeCarrier` are supplied by the caller (`src/tools/test.ts` wires
 * them against a real connection), so the selection logic can be exercised
 * with fakes and stays free of the wire protocol entirely.
 *
 * Algorithm, followed in this exact order because it is the shape the tool
 * layer's SELECTION section and truncation notes are written against:
 *
 *  1. Each changed object is itself a candidate carrier (a change to a test
 *     class is its own risk) — probed first. This probe is NOT a "consumer"
 *     probe and does not count toward `consumersExamined`.
 *  2. For each changed object, in order, its where-used rows are fetched and
 *     filtered to {@link IMPACTED_CONSUMER_KINDS}, with the changed objects
 *     themselves dropped and per-object duplicates collapsed.
 *  3. Kept consumers are probed in order, up to {@link PER_OBJECT_CONSUMER_CAP}
 *     per changed object and {@link SELECTED_CARRIER_CAP} selected carriers in
 *     total. Both caps are disclosed via `perObjectCapped`/`neverExamined`
 *     /`carrierCapHit` — never silently applied.
 *  4. A carrier reached by more than one path (changed directly AND used by
 *     another changed object, or used by two different changed objects) is
 *     recorded once, with its reasons concatenated in the order they were
 *     established.
 */

export const IMPACTED_CONSUMER_KINDS: readonly string[] = ["CLAS", "PROG", "FUGR"];

/** Per changed object, how many of its where-used consumers get probed. */
export const PER_OBJECT_CONSUMER_CAP = 20;

/** Total number of carriers this selection will ever run tests for. */
export const SELECTED_CARRIER_CAP = 10;

export interface ChangedObject {
  readonly name: string;
  readonly type?: string;
}

export interface ConsumerRef {
  readonly name: string;
  readonly type: string;
}

export type CarrierProbe = "has-tests" | "no-tests" | "unknown";

export interface SelectedCarrier {
  readonly name: string;
  /** e.g. "CLAS/OC" — "" when the carrier's type was never established. */
  readonly type: string;
  readonly reason: string;
  readonly probe: CarrierProbe;
}

export interface ImpactedSelection {
  readonly changed: readonly ChangedObject[];
  readonly selected: readonly SelectedCarrier[];
  /** Consumers actually probed via `deps.probeCarrier` — excludes the changed objects' own probes. */
  readonly consumersExamined: number;
  /**
   * Consumers that were seen (kept after filtering/dedup) but never probed
   * because a cap stopped selection first, named and grouped by the changed
   * object whose where-used list they came from. A total count is the sum
   * of the `notExamined` array lengths — deliberately not a separate field,
   * so callers cannot drop the names and keep only the number.
   */
  readonly perObjectCapped: readonly { readonly object: string; readonly notExamined: readonly string[] }[];
  /**
   * Changed objects whose `whereUsed` was never even called because the
   * total carrier cap ({@link SELECTED_CARRIER_CAP}) was already reached
   * before selection got to them. Their consumer count is genuinely
   * *unknown* — not zero — and they are deliberately absent from
   * `perObjectCapped`, which only ever names consumers that were actually
   * seen.
   */
  readonly neverExamined: readonly string[];
  readonly carrierCapHit: boolean;
}

export interface ImpactedDeps {
  /** Consumers of `obj`, unfiltered — `selectImpacted` applies `IMPACTED_CONSUMER_KINDS` and dedup itself. */
  whereUsed(obj: ChangedObject): Promise<readonly ConsumerRef[]>;
  probeCarrier(obj: ConsumerRef): Promise<CarrierProbe>;
}

/** The part of a type code before the first "/", upper-cased. A bare, slash-less code is returned as-is. */
function kindOf(type: string): string {
  const idx = type.indexOf("/");
  return (idx >= 0 ? type.slice(0, idx) : type).trim().toUpperCase();
}

export async function selectImpacted(
  changed: readonly ChangedObject[],
  deps: ImpactedDeps,
): Promise<ImpactedSelection> {
  const changedNamesUpper = new Set(changed.map((c) => c.name.toUpperCase()));

  const selectedOrder: string[] = [];
  const selectedByName = new Map<string, SelectedCarrier>();

  function select(name: string, type: string, reason: string, probe: CarrierProbe): void {
    const key = name.toUpperCase();
    const existing = selectedByName.get(key);
    if (existing) {
      selectedByName.set(key, { ...existing, reason: `${existing.reason}, ${reason}` });
      return;
    }
    selectedByName.set(key, { name, type, reason, probe });
    selectedOrder.push(key);
  }

  // -- step 1: each changed object as a candidate carrier in its own right --
  for (const c of changed) {
    const probe = await deps.probeCarrier({ name: c.name, type: c.type ?? "" });
    if (probe === "no-tests") continue;
    select(c.name, c.type ?? "", "changed directly", probe);
  }

  // -- steps 2-4: consumers, subject to the per-object and carrier caps --
  let consumersExamined = 0;
  const capByObject = new Map<string, string[]>();
  const addCap = (objectName: string, names: readonly string[]): void => {
    if (names.length === 0) return;
    const existing = capByObject.get(objectName);
    if (existing) existing.push(...names);
    else capByObject.set(objectName, [...names]);
  };
  let carrierCapHit = selectedByName.size >= SELECTED_CARRIER_CAP;

  let i = 0;
  for (; i < changed.length; i++) {
    // Never call whereUsed for a changed object we won't get to — its
    // consumer count is then simply unknown, not "zero". Left as `i` so the
    // slice below can name every changed object this loop never reached.
    if (carrierCapHit) break;
    const c = changed[i]!;

    const rows = await deps.whereUsed(c);
    const seenThisObject = new Set<string>();
    const kept: ConsumerRef[] = [];
    for (const r of rows) {
      if (!IMPACTED_CONSUMER_KINDS.includes(kindOf(r.type))) continue;
      const upper = r.name.toUpperCase();
      if (changedNamesUpper.has(upper)) continue; // self or another changed object
      if (seenThisObject.has(upper)) continue; // per-object dedup, first occurrence kept
      seenThisObject.add(upper);
      kept.push(r);
    }

    const toProbe = kept.slice(0, PER_OBJECT_CONSUMER_CAP);
    const overPerObjectCap = kept.slice(toProbe.length);
    if (overPerObjectCap.length > 0) {
      addCap(c.name, overPerObjectCap.map((r) => r.name));
    }

    for (let j = 0; j < toProbe.length; j++) {
      const consumer = toProbe[j]!;
      const probe = await deps.probeCarrier(consumer);
      consumersExamined++;
      if (probe !== "no-tests") {
        select(consumer.name, consumer.type, `uses ${c.name}`, probe);
      }
      if (selectedByName.size >= SELECTED_CARRIER_CAP) {
        carrierCapHit = true;
        const remaining = toProbe.slice(j + 1);
        if (remaining.length > 0) {
          addCap(c.name, remaining.map((r) => r.name));
        }
        break;
      }
    }
  }

  const neverExamined = changed.slice(i).map((c) => c.name);

  const perObjectCapped = changed
    .map((c) => ({ object: c.name, notExamined: capByObject.get(c.name) ?? [] }))
    .filter((e) => e.notExamined.length > 0);

  return {
    changed,
    selected: selectedOrder.map((k) => selectedByName.get(k)!),
    consumersExamined,
    perObjectCapped,
    neverExamined,
    carrierCapHit,
  };
}
