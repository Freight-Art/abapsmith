/**
 * Issue #74: `abap_read {"object":"<name>","type":"DEVC/K"}` used to be
 * UNSUPPORTED. `readPackage` (src/adt/ddic.ts) now renders a package's
 * header (GET /sap/bc/adt/packages/<name>) plus its node-structure listing
 * (POST /repository/nodestructure?parent_type=DEVC/K), with `types`/`depth`
 * options and a `MAX_PACKAGE_EXPANSIONS` round-trip cap.
 *
 * `readPackage` itself is not exported — every test here drives it through
 * `readDdic`, the same way `test/ddic.test.ts`'s own package tests do. The
 * fake connection follows that file's `stubConn`/`obj` pattern (there is no
 * shared cross-file fake for this — see test/helpers/, which has none for
 * DDIC/package reads).
 *
 * Header field provenance is pinned from two live captures, read from disk
 * (never pasted into this file):
 *   - test/fixtures/live-captured/857-i74-package-header-z-badi-check.xml
 *     — a customer package: <pak:superPackage/> present but attribute-free
 *     (no super package), software component HOME, transport layer ZLB1.
 *   - test/fixtures/live-captured/856-i74-package-header-sabp-unit-core-runtime.xml
 *     — an SAP-standard package: super package SABP_UNIT_CORE, software
 *     component SAP_BASIS, transport layer SAP.
 * The empty-package zero-byte-200 HTTP quirk is pinned from captures
 * 854/877/878/879 (all confirmed zero bytes on disk).
 */
// NB: this side-effect-only import must stay FIRST. src/adt/capabilities.ts
// runs a module-top-level self-check (`assertWritableTypesAreReadable`) that
// calls into src/adt/ddic.ts's `ddicStrategy`. ddic.ts itself pulls in
// index-read.ts -> enhancement-templates.ts -> safety.ts -> capabilities.ts,
// closing a real import cycle. When ddic.ts is the FIRST module touched (as
// it is the moment this file imports `readDdic` below), that cycle reaches
// capabilities.ts's self-check while ddic.ts's own `const DDIC_SOURCE_BASED`
// has not been initialised yet, and the self-check throws
// `ReferenceError: Cannot access 'DDIC_SOURCE_BASED' before initialization`
// (reproduced standalone with `tsx`, independent of vitest — see the final
// report's src/ bug note; not fixed here per this task's file-scope rules).
// Importing capabilities.ts first lets it finish its self-check before
// ddic.ts is ever touched, side-stepping the cycle without editing src/.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readDdic } from "../src/adt/ddic.js";
import type { AbapConnection } from "../src/adt/connection.js";
import type { ResolvedObject } from "../src/adt/resolve.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

/** Live capture 857 (A4H, 2026-09-12) — see file header. */
const Z_BADI_CHECK_HEADER = read("857-i74-package-header-z-badi-check.xml");
/** Live capture 856 (A4H, 2026-09-12) — see file header. */
const SABP_UNIT_CORE_RUNTIME_HEADER = read("856-i74-package-header-sabp-unit-core-runtime.xml");

interface Call {
  uri: string;
}

function stubConn(handlers: {
  get?: (uri: string) => Promise<{ body: string }>;
  nodeContents?: (parentType: string, name?: string) => Promise<unknown>;
  calls?: Call[];
}): AbapConnection {
  const record = (uri: string) => handlers.calls?.push({ uri });
  return {
    cfg: { sid: "A4H" },
    get: async (uri: string) => {
      record(uri);
      if (!handlers.get) throw new Error(`unexpected GET ${uri}`);
      return handlers.get(uri);
    },
    adt: {
      nodeContents: async (parentType: string, name?: string) => {
        record(`nodeContents:${parentType}:${name ?? ""}`);
        if (!handlers.nodeContents) throw new Error("unexpected nodeContents");
        return handlers.nodeContents(parentType, name);
      },
    },
  } as unknown as AbapConnection;
}

function pkg(name: string, uri: string): ResolvedObject {
  return {
    system: "A4H",
    type: "DEVC/K",
    kind: "DEVC",
    label: "package",
    name,
    uri,
    mode: "ddic",
    activation: "unknown",
    spec: { type: "DEVC/K", kind: "DEVC", label: "package", uriPath: "packages", mode: "ddic" },
  } as unknown as ResolvedObject;
}

function node(type: string, name: string, description = ""): Record<string, string> {
  return { OBJECT_TYPE: type, OBJECT_NAME: name, DESCRIPTION: description };
}

describe("readPackage header parsing (live captures 856, 857)", () => {
  it("857 (Z_BADI_CHECK, customer package): responsible, description, packageType, software " +
      "component HOME, transport layer ZLB1 — and the attribute-free <pak:superPackage/> renders as " +
      "'no super package', not a parse failure", async () => {
    const conn = stubConn({
      get: async () => ({ body: Z_BADI_CHECK_HEADER }),
      nodeContents: async () => ({ nodes: [] }),
    });
    const r = await readDdic(conn, pkg("Z_BADI_CHECK", "/sap/bc/adt/packages/z_badi_check"));
    expect(r.meta.responsible).toBe("ROSENKRANZ");
    expect(r.meta.description).toBe("Badi Checks during upgrade");
    expect(r.meta.package_type).toBe("development");
    expect(r.meta.software_component).toBe("HOME");
    expect(r.meta.transport_layer).toBe("ZLB1");
    // Name is "" on the wire (857); parsePackageHeaderXml falls back to the description.
    expect(r.meta.application_component).toBe("No application component assigned");
    // An empty <pak:superPackage/> must come out as undefined, and must NOT be
    // mistaken by fetchPackageHeader for a parse failure (no header-failure note).
    expect(r.meta.super_package).toBeUndefined();
    expect(r.notes.join(" ")).not.toMatch(/header could not be read/i);
  });

  it("856 (SABP_UNIT_CORE_RUNTIME, SAP-standard package): super package SABP_UNIT_CORE, software " +
      "component SAP_BASIS, transport layer SAP, named application component", async () => {
    const conn = stubConn({
      get: async () => ({ body: SABP_UNIT_CORE_RUNTIME_HEADER }),
      nodeContents: async () => ({ nodes: [] }),
    });
    const r = await readDdic(
      conn,
      pkg("SABP_UNIT_CORE_RUNTIME", "/sap/bc/adt/packages/sabp_unit_core_runtime"),
    );
    expect(r.meta.super_package).toBe("SABP_UNIT_CORE");
    expect(r.meta.software_component).toBe("SAP_BASIS");
    expect(r.meta.transport_layer).toBe("SAP");
    expect(r.meta.application_component).toBe("BC-DWB-TOO-UT");
    expect(r.meta.responsible).toBe("SAP");
  });

  it("a failing header fetch does not fail the whole read: the node listing still renders, and a " +
      "note says package_type/description/etc. are UNKNOWN, not confirmed absent", async () => {
    const conn = stubConn({
      get: async () => {
        throw new Error("simulated header transport failure");
      },
      nodeContents: async () => ({ nodes: [node("CLAS/OC", "ZCL_A", "Class A")] }),
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    expect(r.ddl).toContain("ZCL_A");
    expect(r.meta.package_type).toBeUndefined();
    expect(r.meta.description).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/Package header could not be read/);
    expect(r.notes.join(" ")).toMatch(/UNKNOWN here/);
  });
});

describe("readPackage node-structure listing", () => {
  it("groups objects by type, with OBJECTS BY TYPE counts matching the row counts in the listing", async () => {
    const conn = stubConn({
      nodeContents: async () => ({
        nodes: [node("CLAS/OC", "ZCL_A", "A"), node("CLAS/OC", "ZCL_B", "B"), node("DDLS/DF", "ZI_C", "C")],
      }),
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    expect(r.meta.objects).toBe(3);
    const byType = r.sections.find((s) => s.title === "OBJECTS BY TYPE");
    expect(byType).toBeDefined();
    expect(byType!.content).toMatch(/CLAS\/OC\s+2/);
    expect(byType!.content).toMatch(/DDLS\/DF\s+1/);
  });

  it("identifies sub-packages by an EXACT DEVC/K match — folder rows with empty OBJECT_NAME and " +
      "types like DEVC/P, DEVC/I, DEVC/XS are not counted as objects or as sub-packages", async () => {
    const conn = stubConn({
      nodeContents: async () => ({
        nodes: [
          node("DEVC/P", "", "structure folder"),
          node("DEVC/I", "", "interface folder"),
          node("DEVC/XS", "", "xs folder"),
          node("DEVC/K", "ZSUB", "Sub package"),
          node("CLAS/OC", "ZCL_A", "A"),
        ],
      }),
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    // Only the two rows with a non-empty OBJECT_NAME count; the three empty-name
    // folder rows are dropped before anything else runs.
    expect(r.meta.objects).toBe(2);
    expect(r.meta.sub_packages).toBe(1);
    expect(r.ddl).not.toContain("structure folder");
    expect(r.ddl).not.toContain("interface folder");
  });

  it("a package with zero contents (live zero-byte-200 body, captures 854/877/878/879) succeeds " +
      "with an explicit 'genuinely empty' note — it must not throw", async () => {
    const conn = stubConn({
      // abap-adt-api's own nodeContents already normalises the zero-byte body
      // to {nodes: []} before ddic.ts ever sees it (see fetchPackageNodes's
      // doc comment) — that is the correct fake boundary, not raw bytes.
      nodeContents: async () => ({ nodes: [] }),
    });
    const r = await readDdic(conn, pkg("ZAPI_ENABLEMENT", "/sap/bc/adt/packages/zapi_enablement"));
    expect(r.meta.objects).toBe(0);
    expect(r.notes.join(" ")).toMatch(/has no contents/);
    expect(r.notes.join(" ")).toMatch(/genuinely empty package, not a truncated or failed read/);
  });

  it("a types filter matching nothing produces a note naming the unmatched entry — never silence", async () => {
    const conn = stubConn({
      nodeContents: async () => ({ nodes: [node("CLAS/OC", "ZCL_A", "A")] }),
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"), { types: ["DDLS"] });
    expect(r.meta.objects).toBe(0);
    expect(r.notes.join(" ")).toMatch(/types filter matched zero rows for: DDLS/);
  });

  it("bodyLabel is OBJECTS, not the default PSEUDO-DDL — a package listing is not DDL", async () => {
    const conn = stubConn({ nodeContents: async () => ({ nodes: [] }) });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    expect(r.bodyLabel).toBe("OBJECTS");
  });
});

describe("readPackage depth option", () => {
  it("defaults to depth 1: a sub-package is listed but not descended into (one nodeContents call only)", async () => {
    const calls: Call[] = [];
    const conn = stubConn({
      calls,
      nodeContents: async (_type, name) => {
        if (name === "ZPKG") return { nodes: [node("DEVC/K", "ZSUB", "Sub")] };
        throw new Error(`must not expand ${name} at default depth`);
      },
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    expect(calls.filter((c) => c.uri.startsWith("nodeContents:"))).toHaveLength(1);
    expect(r.meta.depth).toBe(1);
    expect(r.meta.sub_packages).toBe(1);
  });

  it("depth:2 expands one level of sub-packages, folding their objects into the same listing", async () => {
    const conn = stubConn({
      nodeContents: async (_type, name) => {
        if (name === "ZPKG") return { nodes: [node("DEVC/K", "ZSUB", "Sub"), node("CLAS/OC", "ZCL_A", "A")] };
        if (name === "ZSUB") return { nodes: [node("CLAS/OC", "ZCL_B", "B")] };
        return { nodes: [] };
      },
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"), { depth: 2 });
    expect(r.meta.objects).toBe(3);
    expect(r.ddl).toContain("ZCL_B");
    expect(r.meta.depth).toBe(2);
  });

  it("depth beyond MAX_PACKAGE_DEPTH (3) is refused BAD_INPUT before any request is made", async () => {
    const calls: Call[] = [];
    const conn = stubConn({
      calls,
      nodeContents: async () => {
        throw new Error("must not be called — depth is validated before any request");
      },
    });
    await expect(
      readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"), { depth: 4 }),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("hits MAX_PACKAGE_EXPANSIONS (25) when a package has more than 25 direct sub-packages at " +
      "depth 2, and names every un-expanded one in a note rather than hiding them", async () => {
    const subNames = Array.from({ length: 30 }, (_, i) => `ZSUB${String(i + 1).padStart(2, "0")}`);
    const conn = stubConn({
      nodeContents: async (_type, name) => {
        if (name === "ZPKG") return { nodes: subNames.map((n) => node("DEVC/K", n, "")) };
        return { nodes: [] };
      },
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"), { depth: 2 });
    const notExpandedNote = r.notes.find((n) => n.includes("MAX_PACKAGE_EXPANSIONS"));
    expect(notExpandedNote).toBeDefined();
    // The first 25 sub-packages (ZSUB01..ZSUB25) were expanded; the remaining
    // 5 (ZSUB26..ZSUB30) hit the cap and must be named, not silently dropped.
    for (const n of subNames.slice(25)) {
      expect(notExpandedNote).toContain(n);
    }
    for (const n of subNames.slice(0, 25)) {
      expect(notExpandedNote).not.toContain(n);
    }
  });
});
