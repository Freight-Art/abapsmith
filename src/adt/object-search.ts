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
  objectType?: string,
): Promise<SearchResult[]> {
  // A sub-typed objectType (e.g. "FUGR/F") must go out raw: the vendor
  // library's searchObject strips everything after the "/" before it ever
  // reaches the wire.
  if (objectType?.includes("/")) {
    const { body } = await conn.get("/sap/bc/adt/repository/informationsystem/search", {
      headers: { Accept: "application/xml" },
      qs: { operation: "quickSearch", query, maxResults: String(maxResults), objectType },
    });
    return parseObjectSearchXml(body);
  }
  try {
    return await conn.adt.searchObject(query, objectType, maxResults);
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    const { body } = await conn.get("/sap/bc/adt/repository/informationsystem/search", {
      headers: { Accept: "application/xml" },
      qs: {
        operation: "quickSearch",
        query,
        maxResults: String(maxResults),
        ...(objectType !== undefined ? { objectType } : {}),
      },
    });
    return parseObjectSearchXml(body);
  }
}
