/**
 * DCLS/DL (CDS access control) is a new registry entry, live-probed on A4H
 * 2026-09-04: ADT discovery advertises `/sap/bc/adt/acm/dcl/sources` with
 * accept `application/vnd.sap.adt.dclSource+xml`; `GET
 * /sap/bc/adt/acm/dcl/sources/i_somi_usr_favorite/source/main` with `Accept:
 * text/plain` → 200 real DCL source; object GET 406s with a generic Accept,
 * 200 with the vendor media type; abap-adt-api's CreatableTypes has a real
 * DCLS/DL entry (creationPath `acm/dcl/sources`). Create/update/activate/
 * delete were then run end to end on A4H, $TMP (`ZTMD_DCL_01`) — hence the
 * verified tri-states below.
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

describe("DCLS/DL URI: acm/dcl/sources", () => {
  it("builds against /acm/dcl/sources/", () => {
    const uri = buildUri(specForType("DCLS/DL")!, "ZTMD_DCL_01");
    expect(uri).toBe("/sap/bc/adt/acm/dcl/sources/ztmd_dcl_01");
  });

  it("reverse-maps a DCL source URI, stripping /source/main and upper-casing the name", () => {
    const hit = specFromUri("/sap/bc/adt/acm/dcl/sources/i_somi_usr_favorite/source/main");
    expect(hit?.spec.type).toBe("DCLS/DL");
    expect(hit?.name).toBe("I_SOMI_USR_FAVORITE");
  });

  it("round-trips buildUri through specFromUri", () => {
    const uri = buildUri(specForType("DCLS/DL")!, "ZTMD_DCL_01");
    const hit = specFromUri(uri);
    expect(hit?.spec.type).toBe("DCLS/DL");
    expect(hit?.name).toBe("ZTMD_DCL_01");
  });
});

describe("DCLS/DL type-code resolution", () => {
  it("resolves both the full type code and the bare kind to the same spec", () => {
    expect(specForType("DCLS/DL")).toBe(specForType("DCLS"));
  });

  it("does not resolve a made-up subtype", () => {
    expect(specForType("DCLS/DF")).toBeUndefined();
  });
});

describe("DCLS/DL keyword resolution", () => {
  it("resolves its own keywords", () => {
    for (const word of [
      "access control",
      "cds access control",
      "define role",
      "authorization role",
      "dcl",
      "dcls",
    ]) {
      expect(specForKeyword(word)?.type).toBe("DCLS/DL");
    }
  });

  it("does not steal DDLS/DF's overlapping CDS keywords", () => {
    for (const word of ["cds", "cds view", "data definition"]) {
      expect(specForKeyword(word)?.type).toBe("DDLS/DF");
    }
  });
});

describe("DCLS/DL registry: write, create, activate, media type", () => {
  const cap = capabilitiesFor("DCLS/DL");

  it("is writable as source and activatable", () => {
    expect(cap?.write?.shape).toBe("source");
    expect(cap?.activate).toBe(true);
  });

  it("carries the DCL vendor media type", () => {
    expect(cap?.mediaType).toBe("application/vnd.sap.adt.dclSource+xml");
  });

  it("creates via abap-adt-api's vendor CreatableTypes table, not a hand-built skeleton", () => {
    expect(cap?.create?.vendor).toBe(true);
    expect(cap?.create?.skeleton).toBeUndefined();
  });
});

describe("DCLS/DL derived sets: writable, creatable, verified, and deletable", () => {
  it("is in WRITABLE_TYPES and CREATABLE_TYPES", () => {
    expect(WRITABLE_TYPES).toContain("DCLS/DL");
    expect(CREATABLE_TYPES).toContain("DCLS/DL");
  });

  // Both gates opened after the 2026-09-04 live create/delete run.
  it("is in VERIFIED_CREATABLE_TYPES and DELETABLE_TYPES", () => {
    expect(capabilitiesFor("DCLS/DL")?.create?.verified).toBe(true);
    expect(capabilitiesFor("DCLS/DL")?.delete).toBe(true);
    expect(VERIFIED_CREATABLE_TYPES).toContain("DCLS/DL");
    expect(DELETABLE_TYPES).toContain("DCLS/DL");
  });
});
