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
/**
 * Live capture 884 (A4H, 2026-09-12) — the real, deliberately-misaligned
 * $TMP nodestructure response: node structure DESCRIPTION values do not
 * belong to the OBJECT_NAME they are serialised next to once a DEVC/K
 * sub-package row is present. See test/fixtures/live-captured/INDEX.md.
 */
const TMP_NODESTRUCTURE_MISALIGNED = read("884-i74-nodestructure-tmp-misalignment.xml");
/**
 * Live capture 885 (A4H, 2026-09-12) — a filtered subset of the
 * informationsystem/search response for the same $TMP read: every object
 * keyed by (type, name) to its own, correct description, independent of
 * wire position. See test/fixtures/live-captured/INDEX.md.
 */
const TMP_QUICKSEARCH_SUBSET = read("885-i74-quicksearch-tmp-subset.xml");

interface Call {
  uri: string;
}

type GetOpts = { headers?: Record<string, string>; qs?: Record<string, string> };

function stubConn(handlers: {
  get?: (uri: string, opts?: GetOpts) => Promise<{ body: string }>;
  nodeContents?: (parentType: string, name?: string) => Promise<unknown>;
  calls?: Call[];
}): AbapConnection {
  const record = (uri: string) => handlers.calls?.push({ uri });
  return {
    cfg: { sid: "A4H" },
    get: async (uri: string, opts?: GetOpts) => {
      record(uri);
      if (!handlers.get) throw new Error(`unexpected GET ${uri}`);
      return handlers.get(uri, opts);
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

/**
 * Parse the OBJECT_TYPE/OBJECT_NAME/DESCRIPTION of every named
 * SEU_ADT_REPOSITORY_OBJ_NODE in a raw nodestructure capture, same shape
 * `abap-adt-api`'s own `nodeContents` hands to `fetchPackageNodes` — used to
 * feed the REAL, deliberately-misaligned live bytes of capture 884 into
 * `readPackage` through the `nodeContents` stub, without pasting any of
 * those bytes into this file.
 */
function parseNodestructureFixture(raw: string): Array<Record<string, string>> {
  const nodes = [...raw.matchAll(/<SEU_ADT_REPOSITORY_OBJ_NODE>(.*?)<\/SEU_ADT_REPOSITORY_OBJ_NODE>/gs)];
  const field = (n: string, tag: string): string => {
    const m = n.match(new RegExp(`<${tag}>(.*?)</${tag}>`, "s"));
    return m ? m[1] : "";
  };
  return nodes
    .map((m) => ({
      OBJECT_TYPE: field(m[1], "OBJECT_TYPE"),
      OBJECT_NAME: field(m[1], "OBJECT_NAME"),
      DESCRIPTION: field(m[1], "DESCRIPTION"),
    }))
    .filter((n) => n.OBJECT_NAME);
}

/**
 * Build a minimal informationsystem/search response in the shape
 * `fetchPackageDescriptionsForOne` parses (`adtcore:objectReferences` >
 * `adtcore:objectReference`, `type`/`name`/`description` attributes) — the
 * synthetic equivalent of `node()` above, for edge cases (a row missing
 * from the keyed source, an HTTP failure) that a real capture cannot show
 * on demand.
 */
function searchXml(entries: Array<{ type: string; name: string; description?: string }>): string {
  const refs = entries
    .map(
      (e) =>
        `<adtcore:objectReference adtcore:uri="/sap/bc/adt/x" adtcore:type="${e.type}" ` +
        `adtcore:name="${e.name}" adtcore:packageName="ZPKG"` +
        (e.description !== undefined ? ` adtcore:description="${e.description}"` : "") +
        `/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">${refs}</adtcore:objectReferences>`
  );
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
    // The sub-package is listed but its own contents were never fetched at
    // this depth — say so, name it, and say how to go deeper, rather than
    // let the listing be read as ZSUB's full contents.
    const note = r.notes.find((n) => n.includes("sub-package(s) are listed but NOT expanded"));
    expect(note).toBeDefined();
    expect(note).toContain("ZSUB");
    expect(note).toContain('abap_read {"object":"ZSUB","type":"DEVC/K"}');
    expect(note).toMatch(/depth/);
  });

  it("bounds the sub-package note's name list to a reasonable number and says how many more when " +
      "many sub-packages are discovered but unexpanded", async () => {
    const subNames = Array.from({ length: 8 }, (_, i) => `ZSUB${i + 1}`);
    const conn = stubConn({
      nodeContents: async (_type, name) => {
        if (name === "ZPKG") return { nodes: subNames.map((n) => node("DEVC/K", n, "")) };
        throw new Error(`must not expand ${name} at default depth`);
      },
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    const note = r.notes.find((n) => n.includes("sub-package(s) are listed but NOT expanded"));
    expect(note).toBeDefined();
    expect(note).toContain("8 sub-package(s)");
    for (const n of subNames.slice(0, 5)) expect(note).toContain(n);
    expect(note).toMatch(/and 3 more/);
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
    // ZSUB — the only sub-package discovered — WAS expanded (its own
    // contents, ZCL_B, were fetched and folded in). The "listed but NOT
    // expanded" note must not fire when every discovered sub-package was
    // in fact expanded.
    expect(r.notes.join(" ")).not.toMatch(/sub-package\(s\) are listed but NOT expanded/);
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
    // The 25 expanded sub-packages contributed no further DEVC/K rows of
    // their own, so there is no depth-exhausted leftover here — a package
    // must never be reported in both the MAX_PACKAGE_EXPANSIONS note and the
    // "listed but NOT expanded" depth note.
    expect(r.notes.join(" ")).not.toMatch(/sub-package\(s\) are listed but NOT expanded/);
  });
});

describe("readPackage description resolution (issue #74 — live captures 884, 885)", () => {
  it("each object gets its OWN description from informationsystem/search, not the node structure's " +
      "misaligned wire DESCRIPTION — pinning ZTESTAI to 'test ai' and ZIF_APACK_MANIFEST to 'APACK: " +
      "Manifest interface', their real descriptions, never the neighbouring row's value capture 884 " +
      "actually sends on the wire", async () => {
    const nodes = parseNodestructureFixture(TMP_NODESTRUCTURE_MISALIGNED);
    // Confirm the fixture itself still carries the misalignment this test
    // guards against, so a future fixture refresh can't silently make this
    // test meaningless.
    const wireZTestai = nodes.find((n) => n.OBJECT_NAME === "ZTESTAI");
    expect(wireZTestai?.DESCRIPTION).toBe("Class ZCL_TMP_COUNT_SFLIGHT");
    const wireApack = nodes.find((n) => n.OBJECT_NAME === "ZIF_APACK_MANIFEST");
    expect(wireApack?.DESCRIPTION).toBe("test ai");

    const conn = stubConn({
      nodeContents: async (_type, name) => {
        if (name === "$TMP") return { nodes };
        return { nodes: [] };
      },
      get: async (uri, opts) => {
        if (uri.includes("informationsystem/search") && opts?.qs?.packageName === "$TMP") {
          return { body: TMP_QUICKSEARCH_SUBSET };
        }
        throw new Error(`unexpected GET ${uri} ${JSON.stringify(opts)}`);
      },
    });
    const r = await readDdic(conn, pkg("$TMP", "/sap/bc/adt/packages/%24tmp"));
    const lines = r.ddl.split("\n");
    const ztestaiLine = lines.find((l) => l.includes("ZTESTAI"));
    const apackLine = lines.find((l) => l.includes("ZIF_APACK_MANIFEST"));
    expect(ztestaiLine).toContain("test ai");
    expect(ztestaiLine).not.toContain("Class ZCL_TMP_COUNT_SFLIGHT");
    expect(apackLine).toContain("APACK: Manifest interface");
    expect(apackLine).not.toContain("test ai");
  });

  it("the sub-package row ($ABAPSMITH_FLUID_API under $TMP) carries its own keyed description, " +
      "'abapsmith fluid API generated objects', in the SUB-PACKAGES section — not empty, and not " +
      "$TMP's own description", async () => {
    const nodes = parseNodestructureFixture(TMP_NODESTRUCTURE_MISALIGNED);
    const conn = stubConn({
      nodeContents: async (_type, name) => {
        if (name === "$TMP") return { nodes };
        return { nodes: [] };
      },
      get: async (uri, opts) => {
        if (uri.includes("informationsystem/search") && opts?.qs?.packageName === "$TMP") {
          return { body: TMP_QUICKSEARCH_SUBSET };
        }
        throw new Error(`unexpected GET ${uri} ${JSON.stringify(opts)}`);
      },
    });
    const r = await readDdic(conn, pkg("$TMP", "/sap/bc/adt/packages/%24tmp"));
    const subSection = r.sections.find((s) => s.title === "SUB-PACKAGES");
    expect(subSection).toBeDefined();
    expect(subSection!.content).toMatch(/\$ABAPSMITH_FLUID_API\s+abapsmith fluid API generated objects/);
  });

  it("a row absent from the keyed informationsystem/search source renders an EMPTY description — " +
      "never the wire's (positionally unreliable) value — and the note counts it", async () => {
    const conn = stubConn({
      nodeContents: async () => ({
        nodes: [
          node("CLAS/OC", "ZCL_A", "wire value for ZCL_A — actually belongs to a different row"),
          node("CLAS/OC", "ZCL_B", "wire value for ZCL_B — actually belongs to a different row"),
        ],
      }),
      get: async (uri, opts) => {
        if (uri.includes("informationsystem/search")) {
          // Only ZCL_A is present in the keyed source; ZCL_B is not.
          return { body: searchXml([{ type: "CLAS/OC", name: "ZCL_A", description: "Class A, for real" }]) };
        }
        throw new Error(`unexpected GET ${uri}`);
      },
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    const lines = r.ddl.split("\n");
    const aLine = lines.find((l) => l.includes("ZCL_A"));
    const bLine = lines.find((l) => l.includes("ZCL_B"));
    expect(aLine).toContain("Class A, for real");
    expect(bLine).not.toContain("wire value for ZCL_B");
    // An empty description column renders as trailing whitespace, not a value.
    expect(bLine?.trim().endsWith("ZCL_B")).toBe(true);
    expect(r.notes.join(" ")).toMatch(/1 row\(s\) render with an empty description/);
  });

  it("the description lookup failing (HTTP error) leaves the listing intact — descriptions render " +
      "empty and a note explains the failure, it is not a hard error", async () => {
    const conn = stubConn({
      nodeContents: async () => ({
        nodes: [node("CLAS/OC", "ZCL_A", "wire value — must not be shown, lookup failed instead")],
      }),
      get: async (uri) => {
        if (uri.includes("informationsystem/search")) {
          throw new Error("simulated HTTP 500 from informationsystem/search");
        }
        // Header fetch — irrelevant to this test, answer with any parseable body.
        return { body: Z_BADI_CHECK_HEADER };
      },
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    expect(r.ddl).toContain("ZCL_A");
    const lines = r.ddl.split("\n");
    const aLine = lines.find((l) => l.includes("ZCL_A"));
    expect(aLine).not.toContain("wire value");
    expect(r.notes.join(" ")).toMatch(/Description lookup failed for: ZPKG\/"Z\*"/);
  });

  it("rows are grouped by their first character and one informationsystem/search request is " +
      "issued per distinct group — never one whole-package request", async () => {
    const calls: Array<{ query?: string; packageName?: string }> = [];
    const conn = stubConn({
      nodeContents: async () => ({
        nodes: [
          node("CLAS/OC", "AAA_ONE", ""),
          node("CLAS/OC", "BBB_TWO", ""),
          node("CLAS/OC", "ZZZ_THREE", ""),
        ],
      }),
      get: async (uri, opts) => {
        if (!uri.includes("informationsystem/search")) throw new Error(`unexpected GET ${uri}`);
        calls.push({ query: opts?.qs?.query, packageName: opts?.qs?.packageName });
        const byLetter: Record<string, { name: string; description: string }> = {
          A: { name: "AAA_ONE", description: "A description" },
          B: { name: "BBB_TWO", description: "B description" },
          Z: { name: "ZZZ_THREE", description: "Z description" },
        };
        const hit = byLetter[(opts?.qs?.query ?? "").charAt(0)];
        return { body: hit ? searchXml([{ type: "CLAS/OC", ...hit }]) : searchXml([]) };
      },
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    // Three distinct starting characters among the rendered rows -> exactly
    // three requests, each scoped to its own <char>* pattern, never a single
    // query=* covering the whole package.
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.query))).toEqual(new Set(["A*", "B*", "Z*"]));
    expect(calls.every((c) => c.packageName === "ZPKG")).toBe(true);
    expect(r.ddl).toContain("A description");
    expect(r.ddl).toContain("B description");
    expect(r.ddl).toContain("Z description");
  });

  it("a group whose request fails leaves ONLY that group's descriptions empty — a sibling group's " +
      "successful lookup is unaffected", async () => {
    const conn = stubConn({
      nodeContents: async () => ({
        nodes: [node("CLAS/OC", "AAA_ONE", ""), node("CLAS/OC", "BBB_TWO", "")],
      }),
      get: async (uri, opts) => {
        if (!uri.includes("informationsystem/search")) throw new Error(`unexpected GET ${uri}`);
        const q = opts?.qs?.query ?? "";
        if (q.startsWith("A")) throw new Error("simulated HTTP 500 for the A* group");
        return { body: searchXml([{ type: "CLAS/OC", name: "BBB_TWO", description: "B description" }]) };
      },
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    const lines = r.ddl.split("\n");
    const aLine = lines.find((l) => l.includes("AAA_ONE"));
    const bLine = lines.find((l) => l.includes("BBB_TWO"));
    expect(aLine?.trim().endsWith("AAA_ONE")).toBe(true); // empty description column
    expect(bLine).toContain("B description");
    expect(r.notes.join(" ")).toMatch(/Description lookup failed for: ZPKG\/"A\*"/);
    // The B group's own (successful) lookup must not be reported as failed —
    // one group's failure must never bleed into another's result.
    expect(r.notes.join(" ")).not.toMatch(/ZPKG\/"B\*"/);
    // AAA_ONE's emptiness is already explained by the "Description lookup
    // failed" note above; it must not ALSO be folded into the unresolved-
    // description count (that would double-count the same row under two
    // contradictory notes — one saying its group failed, the other saying
    // informationsystem/search simply had no match for it).
    expect(r.notes.join(" ")).not.toMatch(/row\(s\) render with an empty description/);
  });

  it("a failing group's own rows are never double-counted into the unresolved-description note — " +
      "only genuinely-absent rows from the SUCCESSFUL group are counted (issue #74 double-count " +
      "regression: fetchPackageDescriptions used a NUL separator, readPackage's rowGroupFailed " +
      "checked a space, so the two could never match)", async () => {
    const conn = stubConn({
      nodeContents: async () => ({
        nodes: [
          node("CLAS/OC", "AAA_ONE", ""),
          node("CLAS/OC", "BBB_TWO", ""),
          node("CLAS/OC", "BBB_THREE", ""),
        ],
      }),
      get: async (uri, opts) => {
        if (!uri.includes("informationsystem/search")) throw new Error(`unexpected GET ${uri}`);
        const q = opts?.qs?.query ?? "";
        if (q.startsWith("A")) throw new Error("simulated HTTP 500 for the A* group");
        // The B* group succeeds but only returns BBB_TWO — BBB_THREE is
        // genuinely absent from the keyed source, independent of any failure.
        return { body: searchXml([{ type: "CLAS/OC", name: "BBB_TWO", description: "B description" }]) };
      },
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    const notes = r.notes.join(" ");
    expect(notes).toMatch(/Description lookup failed for: ZPKG\/"A\*"/);
    // Exactly one row (BBB_THREE) is genuinely unresolved. AAA_ONE must NOT
    // also be counted here just because its own group's request failed.
    expect(notes).toMatch(/1 row\(s\) render with an empty description/);
    expect(notes).not.toMatch(/2 row\(s\) render with an empty description/);
  });

  it("falls back to a single query=* request when the distinct-starting-character count exceeds " +
      "PACKAGE_DESCRIPTION_GROUP_CAP, instead of an unbounded per-character fan-out", async () => {
    // 36 distinct starting characters (A-Z, 0-9) — comfortably over the cap (30).
    const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
    const names = letters.map((c) => `${c}NAME`);
    const calls: Array<{ query?: string }> = [];
    const conn = stubConn({
      nodeContents: async () => ({ nodes: names.map((n) => node("CLAS/OC", n, "")) }),
      get: async (uri, opts) => {
        if (!uri.includes("informationsystem/search")) throw new Error(`unexpected GET ${uri}`);
        calls.push({ query: opts?.qs?.query });
        return {
          body: searchXml(names.map((n) => ({ type: "CLAS/OC", name: n, description: `${n} desc` }))),
        };
      },
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    // Over the cap: exactly one fallback request, scoped to the whole package.
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toBe("*");
    expect(r.ddl).toContain("ANAME desc");
    expect(r.ddl).toContain("9NAME desc");
    expect(r.notes.join(" ")).toMatch(
      /used a single broader query instead of grouping by starting character/,
    );
  });

  it("never runs more than DESCRIPTION_LOOKUP_CONCURRENCY (2) description-lookup requests at " +
      "once, even with many prefix groups to resolve — an unbounded fan-out is what produced the " +
      "live SessionBusyError this bounds (issue #74 follow-up)", async () => {
    // 8 distinct starting characters -> 8 prefix-group tasks, comfortably
    // under PACKAGE_DESCRIPTION_GROUP_CAP (30) so this exercises the normal
    // per-character fan-out, not the whole-package fallback.
    const letters = [..."ABCDEFGH"];
    const names = letters.map((c) => `${c}NAME`);
    let inFlight = 0;
    let maxInFlight = 0;
    const conn = stubConn({
      nodeContents: async () => ({ nodes: names.map((n) => node("CLAS/OC", n, "")) }),
      get: async (uri, opts) => {
        if (!uri.includes("informationsystem/search")) throw new Error(`unexpected GET ${uri}`);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // A real delay forces genuine overlap between requests; without it
        // everything would resolve synchronously-in-order and this test
        // would pass trivially regardless of whether the pool is bounded.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        const char = (opts?.qs?.query ?? "").charAt(0);
        const name = `${char}NAME`;
        return { body: searchXml([{ type: "CLAS/OC", name, description: `${name} desc` }]) };
      },
    });
    const r = await readDdic(conn, pkg("ZPKG", "/sap/bc/adt/packages/zpkg"));
    // The bound must actually be exercised (not incidentally 1 because the
    // stub happened to resolve in order) and must never be exceeded.
    expect(maxInFlight).toBe(2);
    expect(r.ddl).toContain("ANAME desc");
    expect(r.ddl).toContain("HNAME desc");
  });
});
