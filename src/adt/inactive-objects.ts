/**
 * #217 — package-scoped view over ADT's inactive-objects worklist.
 *
 * `/sap/bc/adt/activation/inactiveobjects` (see `fetchInactiveObjects` in
 * object-search.ts) is a flat, per-user list with no package on it anywhere.
 * This module intersects that list with a package's own contents, fetched via
 * the same repository nodestructure endpoint `readPackage` (ddic.ts) uses —
 * the breadth-first sub-package walk here mirrors that one's shape
 * (`MAX_PACKAGE_DEPTH`/`MAX_PACKAGE_EXPANSIONS`) but is independent code, not
 * a shared helper: ddic.ts's `fetchPackageNodes` is module-private.
 */
import type { Node as AdtRepositoryNode } from "abap-adt-api";
import type { AbapConnection } from "./connection.js";
import { fetchInactiveObjects, type InactiveObjectEntry } from "./object-search.js";
import { translateAdtError, type ErrorContext } from "./session.js";

/** Mirrors ddic.ts's `readPackage` caps for the same kind of walk — kept as an independent constant here on purpose (see that file's own comment on why depth is capped at all). */
const MAX_PACKAGE_DEPTH = 3;
const MAX_PACKAGE_EXPANSIONS = 25;

export interface PackageInactiveEntry extends InactiveObjectEntry {
  packageName: string;
}

export interface PackageInactiveListing {
  entries: PackageInactiveEntry[];
  packages: string[];
  truncated: boolean;
  user: string;
}

export interface PackageMember {
  type: string;
  name: string;
  uri: string;
  packageName: string;
}

/**
 * `nodeContents` for one package, tolerant of the zero-byte-200 "empty
 * package" shape (see `fetchPackageNodes` in ddic.ts) — a thrown vendor XML
 * parse error carrying no numeric HTTP status never reached the ABAP handler
 * and is treated the same way: "no nodes", not a failure. A failure the
 * vendor library attached a real status to (401/403/500 …) is a genuine
 * transport/auth problem and is re-thrown, translated.
 */
async function fetchPackageNodes(
  conn: AbapConnection,
  packageName: string,
  ctx: ErrorContext,
): Promise<readonly AdtRepositoryNode[]> {
  try {
    const result = await conn.adt.nodeContents("DEVC/K", packageName);
    return result?.nodes ?? [];
  } catch (e) {
    if (typeof (e as { status?: unknown } | undefined)?.status === "number") {
      throw translateAdtError(e, ctx);
    }
    return [];
  }
}

/**
 * One package's contents, optionally walked breadth-first into sub-packages.
 * `DEVC/K` rows are never themselves members — they are the walk's own
 * frontier — every other named row is.
 */
export async function listPackageMembers(
  conn: AbapConnection,
  packageName: string,
  recursive: boolean,
): Promise<{ members: PackageMember[]; packages: string[]; truncated: boolean }> {
  const root = packageName.toUpperCase();
  const members: PackageMember[] = [];
  const scanned: string[] = [];
  let expansions = 0;
  let expansionCapped = false;

  let frontier: string[] = [root];
  for (let level = 1; level <= MAX_PACKAGE_DEPTH && frontier.length > 0; level++) {
    const nextFrontier: string[] = [];
    for (const pkg of frontier) {
      // Level 1 (the package the caller actually asked for) is the mandatory
      // cost of this call and never counts against the expansion cap — only
      // descending further does (mirrors readPackage in ddic.ts).
      if (level > 1) {
        if (expansions >= MAX_PACKAGE_EXPANSIONS) {
          expansionCapped = true;
          continue;
        }
        expansions++;
      }
      scanned.push(pkg);
      const ctx: ErrorContext = {
        operation: "list inactive objects",
        uri: `/sap/bc/adt/packages/${pkg.toLowerCase()}`,
        name: pkg,
        type: "DEVC/K",
      };
      const nodes = await fetchPackageNodes(conn, pkg, ctx);
      for (const n of nodes) {
        const name = n.OBJECT_NAME ?? "";
        if (!name) continue; // folder nodes (DEVC/P, DEVC/I, …) carry no name
        const type = n.OBJECT_TYPE ?? "";
        if (type.toUpperCase() === "DEVC/K") {
          if (recursive) nextFrontier.push(name.toUpperCase());
          continue;
        }
        members.push({ type, name: name.toUpperCase(), uri: n.OBJECT_URI ?? "", packageName: pkg });
      }
    }
    if (!recursive) break;
    frontier = nextFrontier;
  }
  // Sub-packages still sitting in the frontier once the loop ends were
  // discovered but never scanned — either the depth cap or the expansion cap
  // stopped the walk before reaching them. Either way the listing is
  // incomplete for this package tree.
  const depthExhausted = recursive && frontier.length > 0;

  return { members, packages: scanned, truncated: expansionCapped || depthExhausted };
}

/**
 * Intersects `fetchInactiveObjects` with one package's contents. A match is:
 * same (type, name) as a member, OR the entry's `parentUri` names a member's
 * uri (a function-group include naming its group), OR the entry's own uri
 * sits under a member's uri (a class include, `.../classes/zcl_x/includes/...`).
 * Preserves the inactive list's own order.
 */
export async function listInactiveObjectsOfPackage(
  conn: AbapConnection,
  opts: { packageName: string; recursive?: boolean; user?: string },
): Promise<PackageInactiveListing> {
  const user = (opts.user ?? conn.cfg.user).toUpperCase();
  // Sequential, not parallel — one request at a time, mirroring readPackage's
  // own call shape rather than racing two independent ADT calls.
  const inactive = await fetchInactiveObjects(conn, opts.user);
  const { members, packages, truncated } = await listPackageMembers(
    conn,
    opts.packageName,
    !!opts.recursive,
  );

  // Sub-objects on the worklist (class includes such as CLAS/OM/public,
  // CLAS/OSI; function modules naming their group) are folded into the
  // package member they belong to, once — the member is what gets activated.
  const entries: PackageInactiveEntry[] = [];
  const seen = new Set<string>();
  for (const entry of inactive) {
    const entryUriLower = entry.uri.toLowerCase();
    const parentUriLower = entry.parentUri?.toLowerCase();
    const exact = members.find(
      (m) => m.type.toUpperCase() === entry.type.toUpperCase() && m.name === entry.name.toUpperCase(),
    );
    const match =
      exact ??
      members.find((m) => {
        const memberUriLower = m.uri.toLowerCase();
        if (!memberUriLower) return false;
        if (parentUriLower && memberUriLower === parentUriLower) return true;
        return entryUriLower.startsWith(`${memberUriLower}/`);
      });
    if (!match) continue;
    const key = `${match.type}|${match.name}|${match.packageName}`.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(
      exact
        ? { ...entry, packageName: match.packageName }
        : {
            name: match.name,
            type: match.type,
            uri: match.uri,
            user: entry.user,
            deleted: entry.deleted,
            packageName: match.packageName,
          },
    );
  }

  return { entries, packages, truncated, user };
}
