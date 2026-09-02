/**
 * Process-lifetime cache of the ADT discovery inventory (parsed
 * `CollectionInfo[]`, not a `Discovery` object — `Discovery` holds a
 * session-bound `ADTClient` and cannot be shared), keyed by system identity
 * and shared across every `AbapConnection` this process mints. Avoids
 * re-paying `GET /sap/bc/adt/discovery` + parse (~245ms, 34% of a fresh
 * `connect()`) on every pool slot, since the document describes the SYSTEM,
 * not the session.
 *
 * In-memory and process-lifetime only — never persisted to disk, since a
 * config change (different URL/user/system) between runs must never inherit
 * a stale inventory. See the git history for
 * full rationale, including why the cache key must use the resolved logon
 * client rather than `cfg.client`.
 */
import type { CollectionInfo } from "./discovery.js";

/** The identity a discovery inventory is cached against. */
export interface DiscoveryCacheIdentity {
  url: string;
  /**
   * The RESOLVED logon client — `logonClientFromCookies(conn.cookies())` —
   * NOT `cfg.client` (an empty config client can still resolve to a real
   * one server-side). If it cannot be resolved at all, callers must skip
   * this cache entirely rather than key on `cfg.client`. See archive.
   */
  client: string;
  user: string;
}

/**
 * Canonical key for {@link DiscoveryCacheIdentity}. Mirrors
 * `debugArmLockKey()` in `src/debug/arm-lock.ts`: user upper-cased
 * (case-insensitive), client verbatim (blank vs. set client are different
 * logons), url trimmed only (canonicalisation is `src/config.ts`'s job).
 */
export function discoveryCacheKey(id: DiscoveryCacheIdentity): string {
  return `${id.url.trim()}|${id.client.trim()}|${id.user.trim().toUpperCase()}`;
}

/** No TTL or eviction: a discovery document is valid for the process's entire lifetime. */
const sharedInventories = new Map<string, readonly CollectionInfo[]>();

/** Look up a previously cached inventory. `undefined` on a miss. */
export function getSharedDiscoveryInventory(key: string): readonly CollectionInfo[] | undefined {
  return sharedInventories.get(key);
}

/**
 * Record a successfully parsed inventory. Callers MUST only call this for a
 * probe that genuinely succeeded (`Discovery.loadState === "loaded"`) — this
 * module cannot tell a real inventory from a failed/empty one itself. Stores
 * a defensive copy so the cache isn't mutable via a caller's reference.
 */
export function setSharedDiscoveryInventory(
  key: string,
  collections: readonly CollectionInfo[],
): void {
  sharedInventories.set(key, [...collections]);
}

/**
 * Test-only escape hatch — production never calls this, since the cache is
 * meant to outlive any one connection. Use between test scenarios that reuse
 * the same `(url, client, user)` identity for different fake discovery docs.
 */
export function clearSharedDiscoveryCacheForTests(): void {
  sharedInventories.clear();
}
