/**
 * DDLA/ADF (annotation definition) is a registry entry live-probed on A4H
 * 2026-09-04: ADT discovery advertises `/sap/bc/adt/ddic/ddla/sources`
 * (title "Annotation Definition", accept
 * `application/vnd.sap.adt.ddic.ddla.v1+xml`, category term `ddlaadf`); `GET
 * /sap/bc/adt/ddic/ddla/sources/endusertext/source/main` with `Accept:
 * text/plain` → 200 real annotation-definition source; the object URI 406s
 * with a generic Accept and 200s with the vendor media type, root element
 * `ddla:ddlaSource` carrying `adtcore:type="DDLA/ADF"`; abap-adt-api's
 * CreatableTypes has a DDLA/ADF row. Create is DISPROVEN, not merely
 * unverified: both `abap_write` and a raw `POST .../ddic/ddla/sources` with
 * the vendor body were refused 403 `ExceptionNoAnnotationDefinitionAuthorization`,
 * "You are not authorized to create Annotation Definitions", from an admin
 * user — annotation definitions are SAP-only on this system. Delete stays
 * "unverified": create never succeeded, so delete was never reachable.
 */
import { describe, expect, it } from "vitest";
import {
  CREATABLE_TYPES,
  DELETABLE_TYPES,
  VERIFIED_CREATABLE_TYPES,
  WRITABLE_TYPES,
  capabilitiesFor,
} from "../src/adt/capabilities.js";
import { buildUri, specForKeyword, specForType, specFromUri } from "../src/adt/types.js";

describe("DDLA/ADF URI: ddic/ddla/sources", () => {
  it("builds against /ddic/ddla/sources/", () => {
    const uri = buildUri(specForType("DDLA/ADF")!, "ZTMD_ANNO_01");
    expect(uri).toBe("/sap/bc/adt/ddic/ddla/sources/ztmd_anno_01");
  });

  it("reverse-maps an annotation-definition source URI, stripping /source/main and upper-casing the name", () => {
    const hit = specFromUri("/sap/bc/adt/ddic/ddla/sources/endusertext/source/main");
    expect(hit?.spec.type).toBe("DDLA/ADF");
    expect(hit?.name).toBe("ENDUSERTEXT");
  });

  it("round-trips buildUri through specFromUri", () => {
    const uri = buildUri(specForType("DDLA/ADF")!, "ZTMD_ANNO_01");
    const hit = specFromUri(uri);
    expect(hit?.spec.type).toBe("DDLA/ADF");
    expect(hit?.name).toBe("ZTMD_ANNO_01");
  });
});

describe("DDLA/ADF type-code resolution", () => {
  it("resolves both the full type code and the bare kind to the same spec", () => {
    expect(specForType("DDLA/ADF")).toBe(specForType("DDLA"));
  });

  // Both the appliance's own search response and abap-adt-api's
  // CreatableTypes use DDLA/ADF — don't "correct" this to DDLA/DAS.
  it("does not resolve a made-up subtype", () => {
    expect(specForType("DDLA/DAS")).toBeUndefined();
  });
});

describe("DDLA/ADF keyword resolution", () => {
  it("resolves its own keywords", () => {
    for (const word of ["annotation definition", "ddla", "cds annotation", "annotation"]) {
      expect(specForKeyword(word)?.type).toBe("DDLA/ADF");
    }
  });

  it("does not steal DDLS/DF's or DDLX/EX's overlapping CDS keywords", () => {
    for (const word of ["cds", "cds view", "data definition"]) {
      expect(specForKeyword(word)?.type).toBe("DDLS/DF");
    }
    expect(specForKeyword("metadata extension")?.type).toBe("DDLX/EX");
  });
});

describe("DDLA/ADF registry: write, create, activate, media type", () => {
  const cap = capabilitiesFor("DDLA/ADF");

  it("is writable as source and activatable", () => {
    expect(cap?.write?.shape).toBe("source");
    expect(cap?.activate).toBe(true);
  });

  it("carries the DDLA vendor media type", () => {
    expect(cap?.mediaType).toBe("application/vnd.sap.adt.ddic.ddla.v1+xml");
  });

  it("creates via abap-adt-api's vendor CreatableTypes table, not a hand-built skeleton", () => {
    expect(cap?.create?.vendor).toBe(true);
    expect(cap?.create?.skeleton).toBeUndefined();
  });
});

describe("DDLA/ADF derived sets: writable, but create is disproven and delete stays unverified", () => {
  it("is in WRITABLE_TYPES and CREATABLE_TYPES", () => {
    expect(WRITABLE_TYPES).toContain("DDLA/ADF");
    expect(CREATABLE_TYPES).toContain("DDLA/ADF");
  });

  // Create's gate is shut because it was DISPROVEN live (403
  // ExceptionNoAnnotationDefinitionAuthorization), not because it's
  // untested. Delete stays "unverified" — create never succeeded, so delete
  // was never once reachable to test.
  it("is not in VERIFIED_CREATABLE_TYPES or DELETABLE_TYPES", () => {
    expect(capabilitiesFor("DDLA/ADF")?.create?.verified).toBe(false);
    expect(capabilitiesFor("DDLA/ADF")?.delete).toBe("unverified");
    expect(VERIFIED_CREATABLE_TYPES).not.toContain("DDLA/ADF");
    expect(DELETABLE_TYPES).not.toContain("DDLA/ADF");
  });
});
