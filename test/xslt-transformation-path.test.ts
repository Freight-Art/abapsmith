/**
 * XSLT/VT's `path` used to point at `/sap/bc/adt/xslt/sources/{name}`, a
 * collection that 404s, and the registry entry was bare (`{ label }` only),
 * so the type was neither writable nor creatable. Live-measured 2026-09-04:
 * `GET /sap/bc/adt/xslt/sources/id` → 404, `GET
 * /sap/bc/adt/xslt/transformations/id` → 200, `GET
 * /sap/bc/adt/xslt/transformations/xmlmuster1_html_xslt/source/main` with
 * `Accept: text/plain` → 200 real stylesheet source; ADT discovery
 * advertises only `/xslt/transformations`. `types.ts`'s `path` now points
 * there and `capabilities.ts` now declares write/create/activate. This file
 * pins the corrected URI and the resulting registry shape.
 */
import { describe, expect, it } from "vitest";
import {
  CREATABLE_TYPES,
  DELETABLE_TYPES,
  VERIFIED_CREATABLE_TYPES,
  WRITABLE_TYPES,
  capabilitiesFor,
} from "../src/adt/capabilities.js";
import { buildUri, specForType, specFromUri } from "../src/adt/types.js";

describe("XSLT/VT URI: transformations, not the dead sources collection", () => {
  it("builds against /xslt/transformations/", () => {
    const uri = buildUri(specForType("XSLT/VT")!, "ZTMD_X");
    expect(uri).toBe("/sap/bc/adt/xslt/transformations/ztmd_x");
    expect(uri).not.toContain("/xslt/sources/");
  });

  it("reverse-maps a transformation source URI, stripping /source/main and upper-casing the name", () => {
    const hit = specFromUri("/sap/bc/adt/xslt/transformations/xmlmuster1_html_xslt/source/main");
    expect(hit?.spec.type).toBe("XSLT/VT");
    expect(hit?.name).toBe("XMLMUSTER1_HTML_XSLT");
  });

  it("no longer reverse-maps the dead /xslt/sources/ collection", () => {
    expect(specFromUri("/sap/bc/adt/xslt/sources/foo")).toBeUndefined();
  });
});

describe("XSLT/VT registry: write, create, delete, activate", () => {
  const cap = capabilitiesFor("XSLT/VT");

  it("is writable as source and activatable, with delete verified", () => {
    expect(cap?.write?.shape).toBe("source");
    expect(cap?.activate).toBe(true);
    expect(cap?.delete).toBe(true);
  });

  it("creates via a hand-built skeleton, not abap-adt-api's vendor CreatableTypes table", () => {
    expect(cap?.create?.vendor).toBe(false);
    expect(cap?.create?.verified).toBe(true);
    expect(cap?.create?.skeleton?.rootName).toBe("trans:transformation");
    // Singular URI — the plural form 400s (see this entry's REGISTRY comment).
    expect(cap?.create?.skeleton?.namespace).toBe(
      'xmlns:trans="http://www.sap.com/adt/transformation"',
    );
    expect(cap?.create?.skeleton?.namespace).not.toContain("/transformations");
    expect(cap?.create?.skeleton?.contentType).toBe(
      "application/vnd.sap.adt.transformations+xml",
    );
    // A `; charset=…` parameter on the create POST gets a 406 / SADT_RESOURCE 037
    // (SkeletonCreate.contentType's doc comment) — the skeleton must carry none.
    expect(cap?.create?.skeleton?.contentType).not.toContain(";");
    // Required or the create POST 400s InvalidTransformationValue (see REGISTRY comment).
    expect(cap?.create?.skeleton?.rootAttributes).toContain(
      'trans:transformationType="XSLTProgram"',
    );
  });

  it("carries the same vendor media type read/write use for this type", () => {
    expect(cap?.mediaType).toBe("application/vnd.sap.adt.transformations+xml");
  });
});

describe("XSLT/VT derived sets: reachable, creatable, and deletable", () => {
  it("is writable and creatable", () => {
    expect(WRITABLE_TYPES).toContain("XSLT/VT");
    expect(CREATABLE_TYPES).toContain("XSLT/VT");
  });

  it("is in the verified-creatable and deletable sets — both gate on a strict `true`, and this entry has both", () => {
    expect(VERIFIED_CREATABLE_TYPES).toContain("XSLT/VT");
    expect(DELETABLE_TYPES).toContain("XSLT/VT");
  });
});
