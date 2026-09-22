/**
 * Interface-implementation checks for a class ref site — via ADT's type
 * hierarchy resource when reachable (sees inherited interfaces too), falling
 * back to parsing the definition part when it isn't.
 */
import type { AbapConnection } from "./connection.js";
import { fullParse, xmlArray, xmlNode, xmlNodeAttr } from "abap-adt-api/build/utilities.js";

export const TYPE_HIERARCHY_URL = "/sap/bc/adt/abapsource/typehierarchy";

const CLASS_DEFINITION_LINE = /^\s*class\s+(\S+)\s+definition\b/i;
const CLASS_IMPLEMENTATION_LINE = /^\s*class\s+\S+\s+implementation\b/im;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 1-based line / 0-based column of the class name in `CLASS <name> DEFINITION`, or undefined. */
export function definitionNamePosition(
  source: string,
  className: string,
): { line: number; column: number } | undefined {
  const lines = source.split(/\r?\n/);
  const want = className.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = CLASS_DEFINITION_LINE.exec(line);
    if (m && m[1]!.toLowerCase() === want) {
      return { line: i + 1, column: line.indexOf(m[1]!) };
    }
  }
  return undefined;
}

/** Strips `*` comment lines and trailing `"` comments — just enough to keep the INTERFACES scan from tripping on commented-out code. */
function stripComments(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.startsWith("*") ? "" : line.replace(/".*$/, "")))
    .join("\n");
}

/** Interfaces named by INTERFACES statements in the definition part (upper-cased), plus whether it says INHERITING FROM. */
export function interfacesFromDefinition(source: string): {
  interfaces: string[];
  inheriting: boolean;
} {
  const implMatch = CLASS_IMPLEMENTATION_LINE.exec(source);
  const definitionPart = stripComments(implMatch ? source.slice(0, implMatch.index) : source);

  const interfaces: string[] = [];
  const seen = new Set<string>();
  const stmtRe = /\binterfaces\b\s*:?\s*([^.]*)\./gi;
  let m: RegExpExecArray | null;
  while ((m = stmtRe.exec(definitionPart)) !== null) {
    for (const part of m[1]!.split(",")) {
      const token = part.trim().split(/\s+/)[0];
      if (!token) continue;
      const upper = token.toUpperCase();
      if (!seen.has(upper)) {
        seen.add(upper);
        interfaces.push(upper);
      }
    }
  }

  return {
    interfaces,
    inheriting: /\binheriting\s+from\b/i.test(definitionPart),
  };
}

/** Own + inherited interfaces via the type hierarchy (upper-cased). undefined = resource unavailable (request threw, empty body, or no hierarchy:info element). */
export async function fetchImplementedInterfaces(
  conn: AbapConnection,
  className: string,
  source: string,
): Promise<string[] | undefined> {
  const pos = definitionNamePosition(source, className);
  if (!pos) return undefined;

  let body: string;
  try {
    ({ body } = await conn.post(TYPE_HIERARCHY_URL, {
      headers: { "Content-Type": "text/plain", Accept: "application/*" },
      qs: {
        uri: `/sap/bc/adt/oo/classes/${encodeURIComponent(className.toLowerCase())}/source/main#start=${pos.line},${pos.column}`,
        type: "superTypes",
      },
      body: source,
    }));
  } catch {
    return undefined;
  }
  if (!body.trim()) return undefined;

  const parsed = fullParse(body);
  const info = xmlNode(parsed, "hierarchy:info");
  if (!info) return undefined;

  const entries = xmlArray<unknown>(parsed, "hierarchy:info", "entries", "entry");
  const interfaces: string[] = [];
  for (const e of entries) {
    const attrs = xmlNodeAttr(e) as Record<string, unknown>;
    if (attrs["adtcore:type"] === "INTF/OI" && typeof attrs["adtcore:name"] === "string") {
      interfaces.push((attrs["adtcore:name"] as string).toUpperCase());
    }
  }
  return interfaces;
}

export interface InterfaceCheck {
  readonly implemented: boolean | undefined;
  readonly via: "hierarchy" | "source";
  readonly detail: string;
}

export async function checkClassImplements(
  conn: AbapConnection,
  className: string,
  source: string,
  iface: string,
): Promise<InterfaceCheck> {
  const want = iface.toUpperCase();
  const hierarchy = await fetchImplementedInterfaces(conn, className, source);
  if (hierarchy !== undefined) {
    const implemented = hierarchy.includes(want);
    return {
      implemented,
      via: "hierarchy",
      detail: implemented
        ? `${iface} listed in the ADT type hierarchy`
        : `${iface} not in the ADT type hierarchy (own and inherited interfaces)`,
    };
  }

  const { interfaces, inheriting } = interfacesFromDefinition(source);
  if (interfaces.includes(want)) {
    return {
      implemented: true,
      via: "source",
      detail: `${iface} declared in the definition part`,
    };
  }
  if (inheriting) {
    return {
      implemented: undefined,
      via: "source",
      detail: `${iface} not declared in the definition part, the class inherits from a superclass, and the ADT type hierarchy was unavailable`,
    };
  }
  return {
    implemented: false,
    via: "source",
    detail: `${iface} not declared in the definition part (ADT type hierarchy unavailable)`,
  };
}

/** true when the source has a `METHOD [<intf>~]<name>` statement (case-insensitive). */
export function hasMethodImplementation(source: string, method: string): boolean {
  const re = new RegExp("\\bmethod\\s+(?:[\\w/]+~)?" + escapeRegExp(method) + "\\b", "i");
  return re.test(stripComments(source));
}

/** true when the source has a `CLASS <name> IMPLEMENTATION` statement (case-insensitive). */
export function hasImplementationPart(source: string): boolean {
  return CLASS_IMPLEMENTATION_LINE.test(stripComments(source));
}
