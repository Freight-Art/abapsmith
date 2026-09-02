/**
 * Guards scripts/gen-capability-table.mjs's "not reachable by any write"
 * bucket: telling an agent a type has no route when one exists (e.g.
 * ENHO/XH and ENHS/XS) is worse than saying nothing, so a type with a create
 * path must never land there. Driven off the generator's own bucketing
 * (`buildCapabilityTable`), fed the real `REGISTRY` from source (not
 * `dist/`), not a hand-copied list, so it stays honest as
 * REGISTRY and OUT_OF_REGISTRY_CREATE grow. Also guards the "not reachable"
 * bucket's read claim and that the shipped skill matches what
 * the generator produces, without requiring a build.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCapabilityTable, OUT_OF_REGISTRY_CREATE } from "../scripts/gen-capability-table.mjs";
import { BRIDGE_ONLY_CREATE_TYPES, NON_READABLE_TYPES, REGISTRY } from "../src/adt/capabilities.js";

// Re-declared rather than imported: the script doesn't export its markers,
// and duplicating two constant strings is cheaper than widening its exports.
const BEGIN = "<!-- BEGIN generated: scripts/gen-capability-table.mjs -->";
const END = "<!-- END generated -->";

describe("capability table: unreachable bucket census", () => {
  it("never files a type as unreachable when it has create, bridgeCreate, or an out-of-registry create site", async () => {
    const { buckets } = await buildCapabilityTable(REGISTRY);
    for (const row of buckets.unreachable) {
      expect(row.create, `${row.type}: filed unreachable but REGISTRY create is "${row.create}"`).toBe("—");
      expect(row.bridge, `${row.type}: filed unreachable but has a bridgeCreate`).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(OUT_OF_REGISTRY_CREATE, row.type),
        `${row.type}: filed unreachable but has an out-of-registry create site`,
      ).toBe(false);
    }
  });

  it("keeps every known out-of-registry create site out of the unreachable bucket", async () => {
    const { buckets } = await buildCapabilityTable(REGISTRY);
    const unreachableTypes = new Set(buckets.unreachable.map((r) => r.type));
    for (const type of Object.keys(OUT_OF_REGISTRY_CREATE)) {
      expect(unreachableTypes.has(type), `${type} regressed into the unreachable bucket`).toBe(false);
    }
  });

  // Without this, a bucketing change that returned nothing for every bucket
  // would leave the two tests above vacuously passing (an empty unreachable
  // bucket trivially satisfies both `for` loops).
  it("actually buckets the whole registry, and the unreachable bucket is non-empty", async () => {
    const { buckets } = await buildCapabilityTable(REGISTRY);
    const total =
      buckets.creatable.length +
      buckets.bridged.length +
      buckets.outOfRegistry.length +
      buckets.writableOnly.length +
      buckets.unreachable.length;
    expect(total).toBe(Object.keys(REGISTRY).length);
    expect(buckets.unreachable.length).toBeGreaterThan(0);
  });

  it("buckets the registry it is handed, so the census can never report on a stale dist/ build", async () => {
    const { buckets } = await buildCapabilityTable({ "ZZZ/QQ": { label: "synthetic" } });
    expect(buckets.unreachable.map((r) => r.type)).toEqual(["ZZZ/QQ"]);
    expect(buckets.creatable).toEqual([]);
    expect(buckets.bridged).toEqual([]);
    expect(buckets.outOfRegistry).toEqual([]);
    expect(buckets.writableOnly).toEqual([]);
  });

  // Property derived from REGISTRY, not a string echo (the old
  // label claimed "Read-only here" for all nine, which was false for six).
  // Pre-fix, every unreachable type sat on one shared flat-list line, so
  // "readable" and "unreadable" types were never distinguishable by line;
  // post-fix they're on two separate lines. A line that mixes both groups
  // is the defect, regardless of what words surround it.
  it("never puts a readable and an unreadable type on the same line of the unreachable bucket", async () => {
    const { table, buckets } = await buildCapabilityTable(REGISTRY);
    const readableTypes = buckets.unreachable.filter((r) => !REGISTRY[r.type]?.unsupported).map((r) => r.type);
    const unreadableTypes = buckets.unreachable.filter((r) => REGISTRY[r.type]?.unsupported).map((r) => r.type);
    // Non-vacuity: both groups must be non-empty, or "no line mixes them" is
    // trivially true because there's nothing on one side to mix in.
    expect(readableTypes.length, "no readable type in the unreachable bucket to test against").toBeGreaterThan(0);
    expect(unreadableTypes.length, "no unreadable type in the unreachable bucket to test against").toBeGreaterThan(0);

    const unreachableSection = table.slice(table.indexOf("Not reachable by any write"));
    for (const line of unreachableSection.split("\n")) {
      const mentionsReadable = readableTypes.some((t) => line.includes(`\`${t}\``));
      const mentionsUnreadable = unreadableTypes.some((t) => line.includes(`\`${t}\``));
      expect(mentionsReadable && mentionsUnreadable, `line mixes readable and unreadable types: ${line}`).toBe(false);
    }
  });
});

describe("capability table: bridgeDelete requires an explicit note", () => {
  // A `bridgeDelete` type with no BRIDGE_DELETE_NOTE entry
  // used to silently inherit "via the bridge — create is reversible.", an
  // unqualified guarantee the registry doesn't back for every such type. The
  // fallback must now refuse to guess and throw instead.
  it("throws rather than emit the generic reversibility phrasing for an unnoted bridgeDelete type", async () => {
    const registry = {
      "ZZZ/QQ": { label: "synthetic", bridgeCreate: {}, bridgeDelete: {} },
    };
    await expect(buildCapabilityTable(registry)).rejects.toThrow(/ZZZ\/QQ.*BRIDGE_DELETE_NOTE/s);
  });

  it("still renders every real bridgeDelete type, so REGISTRY itself has a note for each one today", async () => {
    const { table } = await buildCapabilityTable(REGISTRY);
    expect(table).toContain("DEVC/K");
    expect(table).toContain("VIEW/DV");
    expect(table).toContain("TRAN/T");
  });
});

describe("capability table: bridge-only-create types state their update position", () => {
  // VIEW/DV was creatable and deletable through the classrun
  // bridge but silent on whether it could be CHANGED, unlike TRAN/T, whose
  // `bridgeCreate.limits` already said so. A type with no create route but
  // the bridge (`BRIDGE_ONLY_CREATE_TYPES` — today VIEW/DV, TRAN/T) has no
  // `write` field either, so `abap_write` can never resolve a URI to change
  // one; that fact belongs in `limits`, not left for a caller to discover by
  // trying. Matches on content, not on the exact sentence this fix wrote, so
  // it keeps holding if the wording is later reworded.
  it("every BRIDGE_ONLY_CREATE_TYPES entry's bridgeCreate.limits documents that update/change is unsupported", () => {
    expect(BRIDGE_ONLY_CREATE_TYPES.length).toBeGreaterThan(0);
    for (const type of BRIDGE_ONLY_CREATE_TYPES) {
      const limits = REGISTRY[type]?.bridgeCreate?.limits ?? "";
      expect(limits.length, `${type}: no bridgeCreate.limits text at all`).toBeGreaterThan(0);
      expect(
        /update|chang(e|ing)/i.test(limits) && /not support/i.test(limits),
        `${type}: bridgeCreate.limits never states its update/change position: ${limits}`,
      ).toBe(true);
    }
  });
});

describe("capability table: skill is current without a build", () => {
  it("the generated block in skills/abapsmith-orient/SKILL.md matches buildCapabilityTable(REGISTRY)", async () => {
    const skillPath = new URL("../skills/abapsmith-orient/SKILL.md", import.meta.url);
    const body = readFileSync(skillPath, "utf8");
    const start = body.indexOf(BEGIN);
    const stop = body.indexOf(END);
    expect(start, "BEGIN marker not found in SKILL.md").not.toBe(-1);
    expect(stop, "END marker not found in SKILL.md").not.toBe(-1);
    const current = body.slice(start, stop + END.length);

    const { table } = await buildCapabilityTable(REGISTRY);
    expect(current.trim()).toBe(table.trim());
  });

  // The generated block above states the write side of NON_READABLE_TYPES
  // (the "not readable either" bullet) but says nothing about VIEW/DV and
  // TRAN/T being unreadable too — that's hand-written territory. Derived
  // from NON_READABLE_TYPES itself, not a copied list, so it can't drift.
  it("the hand-written region names every NON_READABLE_TYPES code, including VIEW/DV and TRAN/T", () => {
    expect(NON_READABLE_TYPES).toEqual(expect.arrayContaining(["VIEW/DV", "TRAN/T"]));

    const skillPath = new URL("../skills/abapsmith-orient/SKILL.md", import.meta.url);
    const body = readFileSync(skillPath, "utf8");
    const stop = body.indexOf(END);
    expect(stop, "END marker not found in SKILL.md").not.toBe(-1);
    const handWritten = body.slice(stop + END.length);

    for (const code of NON_READABLE_TYPES) {
      expect(handWritten.includes(code), `${code} not mentioned in the hand-written region of SKILL.md`).toBe(true);
    }
  });
});
