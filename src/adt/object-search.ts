/**
 * #172: the library's searchObject parses attributes with parseAttributeValue:
 * true, so a name like "                                00" becomes the number
 * 0 and its own `.match(...)` throws a TypeError. This keeps the library call
 * primary and only re-fetches with string attributes on that exact failure.
 */
import { XMLParser } from "fast-xml-parser";
import type { SearchResult } from "abap-adt-api";
import type { AbapConnection } from "./connection.js";

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  trimValues: false,
});

function asArray(node: unknown): Record<string, unknown>[] {
  if (node === undefined || node === null) return [];
  return Array.isArray(node) ? (node as Record<string, unknown>[]) : [node as Record<string, unknown>];
}

export function parseObjectSearchXml(body: string): SearchResult[] {
  const doc = xml.parse(body) as Record<string, any>;
  const root = doc?.["adtcore:objectReferences"] ?? {};
  const rows = asArray(root["adtcore:objectReference"]);
  return rows.map((row) => {
    const result: SearchResult = {
      "adtcore:uri": String(row["adtcore:uri"] ?? ""),
      "adtcore:type": String(row["adtcore:type"] ?? ""),
      "adtcore:name": String(row["adtcore:name"] ?? ""),
    };
    if (row["adtcore:packageName"] !== undefined) result["adtcore:packageName"] = String(row["adtcore:packageName"]);
    if (row["adtcore:description"] !== undefined) result["adtcore:description"] = String(row["adtcore:description"]);
    // Mirror the library's own "NAME (description)" split (older systems).
    const m = result["adtcore:name"].match(/([^\s]*)\s*\((.*)\)/);
    if (m) {
      result["adtcore:name"] = m[1] ?? "";
      if (!result["adtcore:description"]) result["adtcore:description"] = m[2] ?? "";
    }
    return result;
  });
}

export async function searchObjectsTolerant(
  conn: AbapConnection,
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  try {
    return await conn.adt.searchObject(query, undefined, maxResults);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    const { body } = await conn.get("/sap/bc/adt/repository/informationsystem/search", {
      headers: { Accept: "application/xml" },
      qs: { operation: "quickSearch", query, maxResults: String(maxResults) },
    });
    return parseObjectSearchXml(body);
  }
}

// #217: ADT's inactive-objects worklist — `/sap/bc/adt/activation/inactiveobjects`.
// It carries no package (see src/adt/inactive-objects.ts for the client-side
// package scoping). Imported here, at point of use, rather than hoisted to the
// top import block, so this append does not touch the existing lines above.
import { translateAdtError } from "./session.js";

export interface InactiveObjectEntry {
  name: string;
  type: string;
  uri: string;
  user: string;
  deleted: boolean;
  parentUri?: string;
  transport?: string;
}

/**
 * Parses the `ioc:inactiveObjects` envelope. Empty body / self-closing root
 * (`<ioc:inactiveObjects .../>`, the "nothing inactive" shape) -> `[]`. An
 * `ioc:entry` whose `ioc:object` carries no `ioc:ref` is skipped — there is
 * nothing to name the object by.
 */
export function parseInactiveObjectsXml(body: string): InactiveObjectEntry[] {
  if (!body || !body.trim()) return [];
  const doc = xml.parse(body) as Record<string, any>;
  const root = doc?.["ioc:inactiveObjects"];
  if (!root || typeof root !== "object") return [];

  const entries = asArray(root["ioc:entry"]);
  const out: InactiveObjectEntry[] = [];
  for (const entry of entries) {
    const objNode = asArray((entry as Record<string, unknown>)["ioc:object"])[0] as
      | Record<string, unknown>
      | undefined;
    if (!objNode) continue;
    const ref = asArray(objNode["ioc:ref"])[0] as Record<string, unknown> | undefined;
    if (!ref) continue;

    const transportNode = asArray((entry as Record<string, unknown>)["ioc:transport"])[0] as
      | Record<string, unknown>
      | undefined;
    const transportRef = transportNode
      ? (asArray(transportNode["ioc:ref"])[0] as Record<string, unknown> | undefined)
      : undefined;

    out.push({
      name: String(ref["adtcore:name"] ?? ""),
      type: String(ref["adtcore:type"] ?? ""),
      uri: String(ref["adtcore:uri"] ?? ""),
      user: String(objNode["ioc:user"] ?? ""),
      deleted: String(objNode["ioc:deleted"] ?? "").toLowerCase() === "true",
      ...(ref["adtcore:parentUri"] !== undefined ? { parentUri: String(ref["adtcore:parentUri"]) } : {}),
      ...(transportRef?.["adtcore:name"] !== undefined ? { transport: String(transportRef["adtcore:name"]) } : {}),
    });
  }
  return out;
}

/**
 * Fetches the current (or named) user's inactive-objects worklist. `user`
 * undefined -> the connected user's own worklist; ADT has no `USERNAME=*`
 * wildcard (verified live — it returns nothing), so there is no "everyone's"
 * mode here.
 */
export async function fetchInactiveObjects(
  conn: AbapConnection,
  user?: string,
): Promise<InactiveObjectEntry[]> {
  const uri = "/sap/bc/adt/activation/inactiveobjects";
  try {
    const { body } = await conn.get(uri, {
      headers: {
        Accept: "application/vnd.sap.adt.inactivectsobjects.v1+xml, application/xml;q=0.8",
      },
      ...(user ? { qs: { USERNAME: user.toUpperCase() } } : {}),
    });
    if (!body || !body.trim()) return [];
    return parseInactiveObjectsXml(body);
  } catch (e) {
    throw translateAdtError(e, { operation: "list inactive objects", uri });
  }
}
