/**
 * #217 — `listInactiveObjectsOfPackage` folds a class's inactive sub-includes
 * into the one CLAS/OC package member, and the `package` form of
 * abap_activate refuses a stray `corr_nr` before touching the connection.
 */
import { describe, expect, it } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import { listInactiveObjectsOfPackage } from "../src/adt/inactive-objects.js";
import { SafetyGate } from "../src/safety.js";
import { abapActivate } from "../src/tools/activate.js";

const INACTIVE_XML = `<?xml version="1.0" encoding="utf-8"?>
<ioc:inactiveObjects xmlns:ioc="http://www.sap.com/abapxml/inactiveCtsObjects" xmlns:adtcore="http://www.sap.com/adt/core">
  <ioc:entry>
    <ioc:object ioc:user="ABAPSMITH" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/zcl_as_t217" adtcore:type="CLAS/OC" adtcore:name="ZCL_AS_T217"/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="ABAPSMITH" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/zcl_as_t217/includes/definitions" adtcore:type="CLAS/OCN/definitions" adtcore:name="ZCL_AS_T217" adtcore:parentUri="/sap/bc/adt/oo/classes/zcl_as_t217"/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="ABAPSMITH" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/oo/classes/zcl_as_t217/source/main#type=CLAS%2FOM;name=PROBE" adtcore:type="CLAS/OM/public" adtcore:name="ZCL_AS_T217   PROBE"/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="ABAPSMITH" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/ddic/tables/zas_t217" adtcore:type="TABL/DT" adtcore:name="ZAS_T217"/>
    </ioc:object>
  </ioc:entry>
  <ioc:entry>
    <ioc:object ioc:user="ABAPSMITH" ioc:deleted="false">
      <ioc:ref adtcore:uri="/sap/bc/adt/programs/programs/zas_elsewhere" adtcore:type="PROG/P" adtcore:name="ZAS_ELSEWHERE"/>
    </ioc:object>
  </ioc:entry>
</ioc:inactiveObjects>`;

function fakeConn(calls: string[]): AbapConnection {
  return {
    cfg: { sid: "A4H", user: "abapsmith" },
    get: async (uri: string) => {
      calls.push(`GET ${uri}`);
      return { body: INACTIVE_XML, headers: {} };
    },
    adt: {
      nodeContents: async (parentType: string, name?: string) => {
        calls.push(`nodeContents ${parentType} ${name ?? ""}`);
        return {
          nodes: [
            { OBJECT_TYPE: "CLAS/OC", OBJECT_NAME: "ZCL_AS_T217", OBJECT_URI: "/sap/bc/adt/oo/classes/zcl_as_t217" },
            { OBJECT_TYPE: "TABL/DT", OBJECT_NAME: "ZAS_T217", OBJECT_URI: "/sap/bc/adt/ddic/tables/zas_t217" },
            { OBJECT_TYPE: "CLAS/OC", OBJECT_NAME: "ZCL_AS_ACTIVE", OBJECT_URI: "/sap/bc/adt/oo/classes/zcl_as_active" },
          ],
        };
      },
    },
  } as unknown as AbapConnection;
}

describe("listInactiveObjectsOfPackage — sub-include folding", () => {
  it("lists each inactive package member once; class includes fold into the CLAS/OC row; foreign objects are dropped", async () => {
    const calls: string[] = [];
    const listing = await listInactiveObjectsOfPackage(fakeConn(calls), { packageName: "$tmp" });
    expect(calls).toEqual([
      "GET /sap/bc/adt/activation/inactiveobjects",
      "nodeContents DEVC/K $TMP",
    ]);
    expect(listing.user).toBe("ABAPSMITH");
    expect(listing.packages).toEqual(["$TMP"]);
    expect(listing.truncated).toBe(false);
    expect(listing.entries.map((e) => `${e.type} ${e.name} ${e.packageName}`)).toEqual([
      "CLAS/OC ZCL_AS_T217 $TMP",
      "TABL/DT ZAS_T217 $TMP",
    ]);
    expect(listing.entries[0]?.uri).toBe("/sap/bc/adt/oo/classes/zcl_as_t217");
  });

  it("a class present only through its includes still lists as the CLAS/OC member", async () => {
    const calls: string[] = [];
    const conn = fakeConn(calls);
    const onlyIncludes = INACTIVE_XML.replace(/<ioc:entry>\s*<ioc:object[^>]*>\s*<ioc:ref adtcore:uri="\/sap\/bc\/adt\/oo\/classes\/zcl_as_t217" [^>]*\/>\s*<\/ioc:object>\s*<\/ioc:entry>/, "");
    expect(onlyIncludes).not.toBe(INACTIVE_XML);
    (conn as unknown as { get: unknown }).get = async () => ({ body: onlyIncludes, headers: {} });
    const listing = await listInactiveObjectsOfPackage(conn, { packageName: "$TMP" });
    expect(listing.entries.map((e) => `${e.type} ${e.name}`)).toEqual([
      "CLAS/OC ZCL_AS_T217",
      "TABL/DT ZAS_T217",
    ]);
    expect(listing.entries[0]).toMatchObject({
      uri: "/sap/bc/adt/oo/classes/zcl_as_t217",
      user: "ABAPSMITH",
      deleted: false,
      packageName: "$TMP",
    });
  });
});

describe("abapActivate — `package` with a stray `corr_nr`", () => {
  it("is BAD_INPUT naming corr_nr, and never touches the connection", async () => {
    const untouchable = new Proxy({}, {
      get: (_t, prop) => {
        throw new Error(`connection touched: ${String(prop)}`);
      },
    }) as unknown as AbapConnection;
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    const e = await abapActivate(
      untouchable,
      { package: "ZAS_PKG213", corr_nr: "A4HK900123" },
      100_000,
      gate,
    ).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(isAbapError(e)).toBe(true);
    expect((e as AbapError).code).toBe("BAD_INPUT");
    expect((e as AbapError).details).toEqual({ stray: ["corr_nr"] });
    expect((e as AbapError).message).toContain("`corr_nr`");
  });
});
