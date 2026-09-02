/**
 * ABAP object version history, and the version-to-version diff built on it.
 *
 * History: who changed a repository object, when, into which transport — via
 * the Atom feed hanging off the object's structure document
 * (`rel="http://www.sap.com/adt/relations/versions"`), fetched by
 * `abap-adt-api`'s `ADTClient.revisions()`.
 *
 * Diff: the hunks between two of those versions — the point of this module.
 * The version list is not a tool of its own; both it and diff reach the
 * caller through `abap_read`'s `view` parameter (`history` / `diff`).
 *
 * NO DISCOVERY GATE: versioning is a per-object link relation, not a
 * system-wide collection — `/sap/bc/adt/discovery` cannot answer whether it
 * is available (see the git history). Availability
 * is decided on the object's own structure document, inside
 * `ADTClient.revisions()` (`getRevisionLink`); {@link listRevisions} turns
 * its "Revision URL not found" throw into a plain refusal — see
 * {@link NO_VERSIONS_LINK_HINT}.
 *
 * The feed does not arrive as a usable history list — see
 * {@link normaliseRevisions}.
 *
 * Read-only throughout: no lock, no stateful session. Callers gate on
 * `safety.assert("read")` and run through `pool.withRead`.
 */

import { isClassStructure, type Revision } from "abap-adt-api";
import type { AbapConnection } from "./connection.js";
import { AbapError } from "./errors.js";
import type { ResolvedObject } from "./resolve.js";
import { translateAdtError } from "./session.js";
import type { ClassInclude } from "./types.js";

/**
 * The ACTIVE pseudo-version (`ACTIVE_BACKEND_VERSION` in SAP's `Revision.class`).
 * Not a historical snapshot — its content URL serves the object's CURRENT
 * source, and a feed can carry many duplicate copies of it. Diffing it
 * against itself would silently look like a clean diff, so it is excluded
 * from {@link releasedVersions}. See archive for measured duplicate counts.
 */
export const ACTIVE_VERSION_ID = "00000";

/** The INACTIVE pseudo-version — `INACTIVE_BACKEND_VERSION` in `Revision.class`. */
export const INACTIVE_VERSION_ID = "99999";

/** What one feed entry actually is, once its version id has been recovered. */
export type RevisionKind = "active" | "inactive" | "released";

/** A history entry, as this module presents it. Labelled by content, not by library field name. */
export interface RevisionEntry {
  /** Zero-padded version number, e.g. `"00067"`, from `atom:content/@src` — see {@link versionIdFromContentUri}. Empty if unrecognisable. */
  versionId: string;
  /** Whether this row is real history or one of the two pseudo-versions. */
  kind: RevisionKind;
  /** `atom:title` — the transport's free-text description, not a version label. Often `""`. */
  description: string;
  /** Transport request this version was released with (`adtcore:name` of its transport link). Empty when untransported. */
  transport: string;
  /** `atom:author/atom:name`. Empty when the feed emitted a bare `<atom:author/>`. */
  author: string;
  /** `atom:updated`. Empty on entries that carry none — very common on ACTIVE rows. */
  date: string;
  /** `atom:content/@src` — the URI that serves THIS version's source. */
  uri: string;
}

/** The link relation that IS this feature's availability check. */
const VERSIONS_REL = "http://www.sap.com/adt/relations/versions";

/** Why an object legitimately has no version feed at all. */
const NO_VERSIONS_LINK_HINT =
  "Version management is a per-object property, not a system-wide feature: an object type with " +
  "no version management (many DDIC and generated objects) carries no versions link on its ADT " +
  "structure document, so there is nothing to list and nothing to diff. Read the object normally " +
  "(omit `view`) to see its current source.";

/**
 * The `$TMP` fact, stated once and quoted into every refusal that needs it:
 * SAP writes version rows to `VRSD` on transport release or upgrade import,
 * never on local activation, and `$TMP` objects are never transported — so a
 * $TMP object accumulates no history no matter how many times it is
 * reactivated. Verified live on A4H (see archive). `$TMP` and other local
 * objects are routine in day-to-day development, so this is the ordinary
 * case, not an edge case.
 */
export const NO_RELEASED_HISTORY_EXPLANATION =
  "has no released version history: the only entry in its ADT version feed is the ACTIVE " +
  "pseudo-version (00000), which serves the object's CURRENT source rather than a snapshot. SAP " +
  "writes a version row on transport release or upgrade import, never on local activation — so a " +
  "$TMP / local object accumulates no history no matter how many times it is edited and " +
  "reactivated. There is no predecessor to diff against.";

/**
 * Recovers the version number from an entry's content URL:
 * `/sap/bc/adt/{objectpath}/versions/{feedTimestamp}/{versionId}/content` —
 * the version id is the second-to-last path segment.
 *
 * Not read from `atom:id`, which literally contains it: `abap-adt-api` parses
 * the feed with fast-xml-parser's `parseAttributeValue: true`, which turns
 * `<atom:id>00000</atom:id>` into the number `0`, destroying the zero-padding
 * before any consumer sees it. The path segment survives intact.
 *
 * `{feedTimestamp}` is feed-level, identical across every entry of a feed —
 * not a per-version date.
 */
export function versionIdFromContentUri(uri: string): string {
  const path = uri.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const segs = path.split("/");
  if (segs.length < 2) return "";
  const candidate = segs[segs.length - 2] ?? "";
  if (!/^\d{1,5}$/.test(candidate)) return "";
  // Confirm the surrounding shape so a coincidental numeric segment isn't mistaken for a version id.
  const marker = segs[segs.length - 4];
  if (marker !== undefined && marker.toLowerCase() !== "versions") return "";
  return candidate;
}

/** Classifies a version id against the two pseudo-versions SAP reserves. */
export function revisionKind(versionId: string): RevisionKind {
  if (versionId === "") return "released";
  const n = Number(versionId);
  if (n === Number(ACTIVE_VERSION_ID)) return "active";
  if (n === Number(INACTIVE_VERSION_ID)) return "inactive";
  return "released";
}

/**
 * Coerces one `Revision` field to a string, because the declared type lies:
 * `abap-adt-api`'s `fullParse` turns all-digit attributes into JS numbers, and
 * `Revision.author` (unlike its siblings) is never defaulted to `""`, so it is
 * `undefined` when an entry has no `<atom:author>` at all — `.toLowerCase()`
 * on that in {@link selectRevision} would throw. One coercion point rather
 * than `String(...)` scattered at each use site.
 */
function text(value: string | undefined): string {
  return value === undefined || value === null ? "" : String(value);
}

/**
 * Turns the raw feed into something whose order and membership mean what they
 * look like they mean.
 *
 * 1. **Order it.** ADT does not return the feed in any useful order (see
 *    archive for a captured example). Ordering runs over two partitions, not
 *    one comparator, because mixing "compare by number" and "compare by date"
 *    in a single comparator is not a strict weak ordering (constructible
 *    cycle: A>B by number, B>C by date, C>A by date) and would make `sort`
 *    output arbitrary:
 *      - Pseudo-versions (ACTIVE, INACTIVE) come first — ACTIVE serves the
 *        CURRENT source, so it is never older than a released version — and
 *        are ordered among themselves by `atom:updated` descending (stable
 *        sort; empty dates last).
 *      - Released versions are ordered by version number descending, since
 *        that is monotonic and always present, unlike `atom:updated` which is
 *        frequently absent on real data. Versions whose number could not be
 *        recovered fall back to the date rule and sort last.
 * 2. **De-duplicate by version id**, keeping the first occurrence (after step
 *    1, the copy with a real date if any copy has one). The same ACTIVE row
 *    can appear dozens of times in one feed; without this its "predecessor"
 *    would be another copy of itself.
 * 3. Classification is {@link revisionKind}; exclusion of pseudo-versions
 *    happens at selection time ({@link releasedVersions}), not here, so
 *    `view="history"` can still show that an ACTIVE row exists.
 */
export function normaliseRevisions(raw: readonly Revision[]): RevisionEntry[] {
  const mapped: RevisionEntry[] = raw.map((r) => {
    const uri = text(r.uri);
    const versionId = versionIdFromContentUri(uri);
    return {
      versionId,
      kind: revisionKind(versionId),
      description: text(r.versionTitle),
      transport: text(r.version),
      author: text(r.author),
      date: text(r.date),
      uri,
    };
  });

  // Array.prototype.sort is stable since ES2019 — server order among equal dates is guaranteed.
  const byDateDesc = (a: RevisionEntry, b: RevisionEntry): number => {
    if (a.date === b.date) return 0;
    if (a.date === "") return 1;
    if (b.date === "") return -1;
    // ISO-8601 UTC timestamps: lexicographic order is chronological order.
    return a.date < b.date ? 1 : -1;
  };
  const pseudo = mapped.filter((e) => e.kind !== "released").sort(byDateDesc);
  const numbered = mapped
    .filter((e) => e.kind === "released" && e.versionId !== "")
    .sort((a, b) => Number(b.versionId) - Number(a.versionId));
  const unnumbered = mapped
    .filter((e) => e.kind === "released" && e.versionId === "")
    .sort(byDateDesc);
  const sorted = [...pseudo, ...numbered, ...unnumbered];

  const seen = new Set<string>();
  const out: RevisionEntry[] = [];
  for (const entry of sorted) {
    // Unrecoverable version id can't be proven a duplicate, so it's kept.
    if (entry.versionId !== "") {
      if (seen.has(entry.versionId)) continue;
      seen.add(entry.versionId);
    }
    out.push(entry);
  }
  return out;
}

/**
 * Actual history — everything except the ACTIVE and INACTIVE pseudo-versions.
 * Selecting a predecessor from the unfiltered feed would pick another copy of
 * ACTIVE and report "no differences" against the source it was copied from.
 */
export function releasedVersions(entries: readonly RevisionEntry[]): RevisionEntry[] {
  return entries.filter((e) => e.kind === "released");
}

/**
 * Fetches and normalises the version feed for `obj`.
 *
 * Availability is decided per object inside `ADTClient.revisions()`, which
 * resolves the structure document and looks for the versions link relation
 * (on the named class include, for a class) — no URL is templated here.
 */
export async function listRevisions(
  conn: AbapConnection,
  obj: ResolvedObject,
  include?: ClassInclude,
): Promise<RevisionEntry[]> {
  let raw: Revision[];
  try {
    // revisions() takes the OBJECT url and resolves the versions link itself; for a class it also needs the include (defaults to "main").
    raw = await conn.adt.revisions(obj.uri, include);
  } catch (e) {
    const err = translateAdtError(e, {
      operation: "read version history",
      uri: obj.uri,
      name: obj.name,
      type: obj.type,
    });
    // Plain exception (not HTTP error) when the structure carries no versions link — this is the real availability check, not a server fault.
    if (/revision url not found/i.test(err.message)) {
      // Read which includes DO carry the relation off the structure document, not an assumption.
      const versioned = include ? await versionedIncludes(conn, obj.uri) : undefined;
      const others = versioned?.filter((i) => i !== include) ?? [];
      throw new AbapError(
        "UNSUPPORTED",
        `${obj.type} ${obj.name} has no ADT version feed: its object structure carries no ` +
          `"versions" link relation${include ? ` on include ${include}` : ""}, so there is no ` +
          "history to read and nothing to diff." +
          (others.length
            ? ` The includes that DO carry one on this object are: ${others.join(", ")}.`
            : ""),
        {
          type: obj.type,
          name: obj.name,
          uri: obj.uri,
          ...(include ? { include } : {}),
          ...(versioned ? { versionedIncludes: versioned } : {}),
        },
        others.length
          ? `Re-run with include="${others[0]}" to read that include's history.`
          : NO_VERSIONS_LINK_HINT,
      );
    }
    throw err;
  }

  return normaliseRevisions(raw);
}

/**
 * The class includes that actually carry a `versions` link on THIS object,
 * enumerated from its structure document rather than assumed — it can
 * legitimately differ per class. Used only to make a refusal specific; a
 * fetch failure degrades to `undefined` and the generic message rather than
 * becoming a different error. See archive for a verified fixture reference.
 */
async function versionedIncludes(
  conn: AbapConnection,
  uri: string,
): Promise<string[] | undefined> {
  try {
    const struct = await conn.adt.objectStructure(uri);
    if (!isClassStructure(struct)) return undefined;
    return struct.includes
      .filter((i) => (i.links ?? []).some((l) => l.rel === VERSIONS_REL))
      .map((i) => String(i["class:includeType"]));
  } catch {
    return undefined;
  }
}

/** Fetches the source of one specific version, by the `uri` its feed entry carried. */
export async function revisionSource(
  conn: AbapConnection,
  entry: RevisionEntry,
  ctx: { name: string; type: string },
): Promise<string> {
  if (!entry.uri) {
    throw new AbapError(
      "ADT_ERROR",
      `Version ${describeEntry(entry)} of ${ctx.type} ${ctx.name} carries no content URI ` +
        "(the feed entry had no atom:content/@src), so its source cannot be fetched.",
      { type: ctx.type, name: ctx.name, version: entry.versionId },
      'Pick a different version from the history listing (view="history").',
    );
  }
  try {
    return await conn.adt.getObjectSource(entry.uri);
  } catch (e) {
    throw translateAdtError(e, {
      operation: `read source of version ${describeEntry(entry)}`,
      uri: entry.uri,
      name: ctx.name,
      type: ctx.type,
    });
  }
}

/** Short human label for one entry, for error messages and headers. */
export function describeEntry(entry: RevisionEntry): string {
  const id = entry.versionId || "(unnumbered)";
  if (entry.kind === "active") return `${id} (ACTIVE — current source)`;
  if (entry.kind === "inactive") return `${id} (INACTIVE)`;
  return id;
}

/**
 * Resolves a caller-supplied version selector against the feed.
 *
 * Accepted forms, case-insensitive: a version number padded or not
 * (`"00067"`, `"67"`), `"active"`/`"00000"`, `"inactive"`/`"99999"`, or a
 * transport request name (e.g. `"A4HK900021"`).
 *
 * NOT accepted: a positional `#N` handle — refused loudly rather than dropped
 * silently, since duplicate ACTIVE rows make positions meaningless.
 * `atom:title` is also not matched: it is the transport's prose description,
 * not a label.
 */
export function selectRevision(
  entries: readonly RevisionEntry[],
  selector: string,
  ctx: { name: string; type: string; param: string },
): RevisionEntry {
  const want = selector.trim();
  const lower = want.toLowerCase();

  if (/^#\d+$/.test(want)) {
    throw new AbapError(
      "BAD_INPUT",
      `${ctx.param}="${selector}" is a positional handle, and this feature does not have ` +
        "positions. ADT version feeds repeat the same ACTIVE row many times over (68 entries, " +
        "~60 of them identical, on one captured feed), so a position number names nothing " +
        "stable.",
      { type: ctx.type, name: ctx.name, requested: selector },
      'Pass the version NUMBER instead — list them with view="history" — or "active" for the ' +
        "current source.",
    );
  }

  if (lower === "active") {
    const hit = entries.find((e) => e.kind === "active");
    if (hit) return hit;
  }
  if (lower === "inactive") {
    const hit = entries.find((e) => e.kind === "inactive");
    if (hit) return hit;
  }

  if (/^\d+$/.test(want)) {
    const asNumber = Number(want);
    const byNumber = entries.find(
      (e) => e.versionId !== "" && Number(e.versionId) === asNumber,
    );
    if (byNumber) return byNumber;
  }

  const byTransport = entries.find(
    (e) => e.transport !== "" && e.transport.toLowerCase() === lower,
  );
  if (byTransport) return byTransport;

  const released = releasedVersions(entries);
  throw new AbapError(
    "NOT_FOUND",
    `${ctx.param}="${selector}" matches no version of ${ctx.type} ${ctx.name}. The feed has ` +
      `${released.length} released version(s)${released.length ? `: ${released
        .slice(0, 10)
        .map((e) => e.versionId)
        .join(", ")}${released.length > 10 ? ", …" : ""}` : ""}` +
      `${entries.some((e) => e.kind === "active") ? ", plus the ACTIVE pseudo-version 00000" : ""}.`,
    { type: ctx.type, name: ctx.name, requested: selector, released: released.length },
    'Call abap_read with view="history" to list the versions, then pass a version number or its ' +
      "transport. Omitting both from and to diffs the two newest released versions and needs no " +
      "identifier at all.",
  );
}

/**
 * Relative age of two entries, or `undefined` when it genuinely cannot be
 * told. Positive means `a` is newer. Version numbers are preferred over dates
 * since they're monotonic and always present on released versions, while
 * `atom:updated` is frequently missing on real data. When neither signal is
 * available on both sides, this returns `undefined` rather than guessing.
 */
export function compareAge(a: RevisionEntry, b: RevisionEntry): number | undefined {
  if (
    a.kind === "released" &&
    b.kind === "released" &&
    a.versionId !== "" &&
    b.versionId !== ""
  ) {
    return Number(a.versionId) - Number(b.versionId);
  }
  if (a.date !== "" && b.date !== "") {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  }
  return undefined;
}

/** The two feed entries a diff will compare, plus how they were chosen. */
export interface DiffPair {
  older: RevisionEntry;
  newer: RevisionEntry;
  /** True when `newer` was defaulted rather than requested. */
  newerDefaulted: boolean;
  /** True when `older` was defaulted. */
  olderDefaulted: boolean;
  /**
   * Set when the newer side is the ACTIVE pseudo-version, i.e. the object's
   * CURRENT source rather than a released snapshot. Callers must disclose this:
   * the answer is "what has changed since the last release", not "what the last
   * release changed".
   */
  newerIsActive: boolean;
}

/**
 * Refusal for the case that `$TMP` makes ordinary — see
 * {@link NO_RELEASED_HISTORY_EXPLANATION}. Must never be answered by diffing
 * ACTIVE against itself: that would be indistinguishable from a genuinely
 * clean diff.
 */
function noReleasedHistory(ctx: { name: string; type: string }, entries: number): AbapError {
  return new AbapError(
    "NOT_FOUND",
    `${ctx.type} ${ctx.name} ${NO_RELEASED_HISTORY_EXPLANATION}`,
    { type: ctx.type, name: ctx.name, entries, released: 0 },
    "Nothing is wrong with the object or the request — this is what version history looks like " +
      "for a local object. To compare against something, read the current source with a plain " +
      "abap_read (omit `view`) and diff it against whatever you are holding.",
  );
}

/**
 * Picks the pair to diff, so the useful default costs no parameters.
 *
 * With neither `from` nor `to`, compares the two newest RELEASED versions
 * (pseudo-versions excluded — see {@link ACTIVE_VERSION_ID}). Exception: with
 * exactly one released version, the only comparison that exists is that
 * version against the current source, so ACTIVE becomes the newer side and
 * {@link DiffPair.newerIsActive} tells the caller to say so.
 */
export function resolveDiffPair(
  entries: readonly RevisionEntry[],
  from: string | undefined,
  to: string | undefined,
  ctx: { name: string; type: string },
): DiffPair {
  const released = releasedVersions(entries);
  const active = entries.find((e) => e.kind === "active");

  if (entries.length === 0) {
    throw new AbapError(
      "NOT_FOUND",
      `${ctx.type} ${ctx.name} has a version feed, but ADT returned no entries in it, so there ` +
        "is nothing to diff.",
      { type: ctx.type, name: ctx.name },
      NO_VERSIONS_LINK_HINT,
    );
  }
  // The ordinary case for anything this server may have written to $TMP.
  if (released.length === 0 && from === undefined && to === undefined) {
    throw noReleasedHistory(ctx, entries.length);
  }

  const newer = to === undefined ? defaultNewer(released, active, ctx) : selectRevision(entries, to, { ...ctx, param: "to" });
  const newerDefaulted = to === undefined;

  if (from !== undefined) {
    const older = selectRevision(entries, from, { ...ctx, param: "from" });
    if (older.uri === newer.uri) {
      throw new AbapError(
        "BAD_INPUT",
        `from and to both resolved to the same version (${describeEntry(newer)}) of ` +
          `${ctx.type} ${ctx.name}. A version does not differ from itself.`,
        { type: ctx.type, name: ctx.name, version: newer.versionId },
        "Pick two different versions, or omit from to compare against the previous released " +
          "version.",
      );
    }
    // Direction is checked, never silently corrected — a backwards diff inverts every + and -. Only checked when compareAge can actually know it.
    const order = compareAge(older, newer);
    if (order !== undefined && order > 0) {
      throw new AbapError(
        "BAD_INPUT",
        `from=${describeEntry(older)} is NEWER than to=${describeEntry(newer)} for ` +
          `${ctx.type} ${ctx.name}; the diff would read backwards.`,
        { type: ctx.type, name: ctx.name, from: older.versionId, to: newer.versionId },
        "Swap them: from is the older side, to is the newer side.",
      );
    }
    return { older, newer, newerDefaulted, olderDefaulted: false, newerIsActive: newer.kind === "active" };
  }

  const older = predecessorOf(released, newer);
  if (!older) {
    if (released.length === 0) throw noReleasedHistory(ctx, entries.length);
    throw new AbapError(
      "NOT_FOUND",
      `${describeEntry(newer)} is the oldest released version of ${ctx.type} ${ctx.name} that ` +
        "the ADT version feed lists, so it has no predecessor to compare against.",
      { type: ctx.type, name: ctx.name, version: newer.versionId, released: released.length },
      released.length > 1
        ? `Pass an explicit pair, e.g. from="${released[released.length - 1]!.versionId}" ` +
          `to="${released[0]!.versionId}".`
        : "This object has exactly one released version — there is nothing older to compare it " +
          "with.",
    );
  }
  return {
    older,
    newer,
    newerDefaulted,
    olderDefaulted: true,
    newerIsActive: newer.kind === "active",
  };
}

/**
 * The newer side when the caller named none: the newest released version, or —
 * when there is only one released version and therefore no released pair — the
 * current source, so that the single comparison that does exist is offered
 * instead of a refusal.
 */
function defaultNewer(
  released: readonly RevisionEntry[],
  active: RevisionEntry | undefined,
  ctx: { name: string; type: string },
): RevisionEntry {
  if (released.length >= 2) return released[0]!;
  if (released.length === 1 && active) return active;
  if (released.length === 1) return released[0]!;
  throw noReleasedHistory(ctx, released.length);
}

/**
 * The released version immediately before `newer`. `released` is already
 * newest-first (see {@link normaliseRevisions}). When `newer` is ACTIVE (the
 * current source), its predecessor is the newest released version.
 */
function predecessorOf(
  released: readonly RevisionEntry[],
  newer: RevisionEntry,
): RevisionEntry | undefined {
  if (newer.kind !== "released") return released[0];
  const idx = released.findIndex((e) => e.uri === newer.uri);
  if (idx === -1) return released[0];
  return released[idx + 1];
}
