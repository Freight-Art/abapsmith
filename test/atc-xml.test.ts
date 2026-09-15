/**
 * `src/adt/atc-xml.ts` — ATC response parsing.
 *
 * ## Two kinds of document in this file: real captures, and synthetic doubles.
 *
 * Real captures now exist, under `test/fixtures/live-captured/`, recorded
 * against an A4H appliance — see that module's docblock for which file backs
 * which shape. Those tests are read straight off the fixture with
 * `readFileSync` (idiom shared with `test/tools-atc.test.ts`) and assert the
 * concrete values the server actually sent, not values chosen to be
 * convenient.
 *
 * The `SYNTHETIC` constants below remain useful for cases a live capture
 * cannot cheaply produce (a document with an intentionally missing root, a
 * one-element collection collapsing hazard forced by hand) or that no capture
 * happens to exercise yet — each is still marked at its site, and
 * `doc/TESTING/README.md`/`CONTRIBUTING.md`'s point stands: a fixture stops
 * being a check against reality the moment it is invented, so these stay
 * inline, not under `test/fixtures/`, and are never presented as captures.
 * Originally they were built to the shape `abap-adt-api` v8.4.1's ATC client
 * reads (`build/api/atc.js`, `build/api/atc.d.ts`); real captures now confirm
 * most of that shape directly.
 *
 * The tests that carry real weight regardless of provenance are the ones about
 * TYPE COERCION — zero-padded ids surviving as strings, one-element collections
 * not collapsing to objects. Those are properties of `fast-xml-parser`, not of
 * SAP, and they hold whatever the server sends.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  countFindings,
  flattenFindings,
  parseAtcCustomizing,
  parseAtcRunAck,
  parseAtcWorklist,
  parseCheckVariantList,
  systemCheckVariant,
} from "../src/adt/atc-xml.js";
import { SYSTEM_CHECK_VARIANT_PROPERTY } from "../src/adt/atc-query.js";
import { isAbapError } from "../src/adt/errors.js";

const LIVE_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "live-captured",
);
const readLiveFixture = (name: string): string =>
  readFileSync(join(LIVE_FIXTURES, name), "utf8");

// ------------------------------------------------------- synthetic doubles ---

/** SYNTHETIC. Shape per `atc.js:195-207` (`customizing/properties/property`). */
const CUSTOMIZING = `<?xml version="1.0" encoding="UTF-8"?>
<atc:customizing xmlns:atc="http://www.sap.com/adt/atc">
  <properties>
    <property name="systemCheckVariant" value="ABAP_CLOUD_READINESS"/>
    <property name="isCheckVariantChangeable" value="false"/>
  </properties>
  <exemption>
    <reasons>
      <reason id="FPOS" title="False positive" justificationMandatory="true"/>
      <reason id="OTHR" title="Other" justificationMandatory="false"/>
    </reasons>
  </exemption>
</atc:customizing>`;

/**
 * SYNTHETIC. Shape per `atc.js:255-258`: `worklistId` and `worklistTimestamp`
 * are read with the library's node-descent helper, not its attribute
 * extractor, so they are child ELEMENTS. That much is grounded.
 */
const RUN_ACK = `<?xml version="1.0" encoding="UTF-8"?>
<atc:worklistRun xmlns:atc="http://www.sap.com/adt/atc">
  <atc:worklistId>0A1B2C3D4E5F6789</atc:worklistId>
  <atc:worklistTimestamp>2026-08-18T09:30:00Z</atc:worklistTimestamp>
  <atc:infos/>
</atc:worklistRun>`;

/**
 * SYNTHETIC, and INFERRED twice over: that `<info>` exists in a populated form
 * at all, and that `type`/`description` are child elements rather than
 * attributes. The library's decoder implies elements but `infos` is empty in
 * the ordinary case, so that decoder may never have run against one.
 */
const RUN_ACK_WITH_INFOS = `<?xml version="1.0" encoding="UTF-8"?>
<atc:worklistRun xmlns:atc="http://www.sap.com/adt/atc">
  <atc:worklistId>0A1B</atc:worklistId>
  <atc:worklistTimestamp>2026-08-18T09:30:00Z</atc:worklistTimestamp>
  <atc:infos>
    <atc:info>
      <atc:type>WARNING</atc:type>
      <atc:description>Some checks were skipped for this object type.</atc:description>
    </atc:info>
  </atc:infos>
</atc:worklistRun>`;

/** SYNTHETIC. The same information in the attribute shape this parser also reads. */
const RUN_ACK_ATTR_INFOS = `<?xml version="1.0" encoding="UTF-8"?>
<atc:worklistRun xmlns:atc="http://www.sap.com/adt/atc">
  <atc:worklistId>0A1B</atc:worklistId>
  <atc:infos>
    <atc:info type="WARNING" description="Some checks were skipped."/>
  </atc:infos>
</atc:worklistRun>`;

/**
 * SYNTHETIC. Attribute names per the io-ts decoder in `atc.d.ts:89-138`.
 * Deliberately contains: two object sets (one `LAST_RUN`), one object with two
 * findings of different priority, a zero-padded `messageId`, an exempted
 * finding, and a quickfix token.
 */
const WORKLIST = `<?xml version="1.0" encoding="UTF-8"?>
<atcworklist:worklist xmlns:atcworklist="http://www.sap.com/adt/atc/worklist"
    id="0A1B2C3D4E5F6789"
    timestamp="2026-08-18T09:30:00Z"
    usedObjectSet="RUN_00042"
    objectSetIsComplete="true">
  <atcworklist:objectSets>
    <atcworklist:objectSet name="ALL_OBJECTS" title="All objects" kind="COMPLETE"/>
    <atcworklist:objectSet name="RUN_00042" title="Last run" kind="LAST_RUN"/>
  </atcworklist:objectSets>
  <atcworklist:objects>
    <atcworklist:object uri="/sap/bc/adt/oo/classes/zcl_order"
        type="CLAS/OC" name="ZCL_ORDER" packageName="ZDEMO" author="DEVELOPER"
        objectTypeId="CLAS">
      <atcworklist:findings>
        <atcworklist:finding
            uri="/sap/bc/adt/atc/findings/0001"
            location="/sap/bc/adt/oo/classes/zcl_order/source/main#start=42,7"
            priority="1" checkId="CL_CI_TEST_SELECT" checkTitle="SELECT statements"
            messageId="0007" messageTitle="SELECT * used without field list"
            exemptionApproval="" exemptionKind="" quickfixInfo="QF_0001">
          <atcworklist:link href="/sap/bc/adt/atc/findings/0001" rel="self" type="application/xml"/>
        </atcworklist:finding>
        <atcworklist:finding
            uri="/sap/bc/adt/atc/findings/0002"
            location="/sap/bc/adt/oo/classes/zcl_order/source/main#start=8,1"
            priority="3" checkId="CL_CI_TEST_NAMING" checkTitle="Naming conventions"
            messageId="0012" messageTitle="Variable name is not prefixed"
            exemptionApproval="APPROVED" exemptionKind="A"/>
      </atcworklist:findings>
    </atcworklist:object>
  </atcworklist:objects>
</atcworklist:worklist>`;

/** SYNTHETIC. One object, one finding — the collapse hazard in its natural form. */
const WORKLIST_SINGLETON = `<?xml version="1.0" encoding="UTF-8"?>
<atcworklist:worklist xmlns:atcworklist="http://www.sap.com/adt/atc/worklist" id="0A1B">
  <atcworklist:objectSets>
    <atcworklist:objectSet name="RUN_1" title="Last run" kind="LAST_RUN"/>
  </atcworklist:objectSets>
  <atcworklist:objects>
    <atcworklist:object uri="/x" type="PROG/P" name="ZPROG">
      <atcworklist:findings>
        <atcworklist:finding uri="/f/1" location="/x/source/main#start=1,1"
            priority="2" checkId="C" checkTitle="T" messageId="0001" messageTitle="M"
            exemptionApproval="" exemptionKind=""/>
      </atcworklist:findings>
    </atcworklist:object>
  </atcworklist:objects>
</atcworklist:worklist>`;

/** SYNTHETIC. A clean run: no findings at all. */
const WORKLIST_EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<atcworklist:worklist xmlns:atcworklist="http://www.sap.com/adt/atc/worklist"
    id="0A1B" timestamp="2026-08-18T09:30:00Z" objectSetIsComplete="true">
  <atcworklist:objectSets>
    <atcworklist:objectSet name="RUN_1" title="Last run" kind="LAST_RUN"/>
  </atcworklist:objectSets>
  <atcworklist:objects/>
</atcworklist:worklist>`;

// ===========================================================================

describe("customizing", () => {
  it("reads the properties and the exemption reasons", () => {
    const c = parseAtcCustomizing(CUSTOMIZING);
    expect(c.properties).toEqual([
      { name: "systemCheckVariant", value: "ABAP_CLOUD_READINESS" },
      { name: "isCheckVariantChangeable", value: "false" },
    ]);
    expect(c.exemptionReasons).toEqual([
      { id: "FPOS", title: "False positive", justificationMandatory: true },
      { id: "OTHR", title: "Other", justificationMandatory: false },
    ]);
  });

  it("keeps `false` as the string it is on a property value", () => {
    // The library parses with `parseAttributeValue: true`, so its own
    // `AtcCustomizing.properties[].value` is typed `boolean | string`. Here the
    // wire string survives, which is what a contract value should do.
    const c = parseAtcCustomizing(CUSTOMIZING);
    expect(c.properties[1]?.value).toBe("false");
    expect(typeof c.properties[1]?.value).toBe("string");
  });

  it("finds the system check variant by name", () => {
    const c = parseAtcCustomizing(CUSTOMIZING);
    expect(systemCheckVariant(c, SYSTEM_CHECK_VARIANT_PROPERTY)).toBe(
      "ABAP_CLOUD_READINESS",
    );
  });

  it("returns undefined rather than inventing DEFAULT when no variant is set", () => {
    const none = parseAtcCustomizing(
      `<atc:customizing xmlns:atc="x"><properties>` +
        `<property name="somethingElse" value="1"/></properties></atc:customizing>`,
    );
    expect(systemCheckVariant(none, SYSTEM_CHECK_VARIANT_PROPERTY)).toBeUndefined();
  });

  it("treats an empty variant value as absent", () => {
    const blank = parseAtcCustomizing(
      `<atc:customizing xmlns:atc="x"><properties>` +
        `<property name="systemCheckVariant" value="  "/></properties></atc:customizing>`,
    );
    expect(systemCheckVariant(blank, SYSTEM_CHECK_VARIANT_PROPERTY)).toBeUndefined();
  });

  it("survives a customizing document with no exemption block", () => {
    const c = parseAtcCustomizing(
      `<atc:customizing xmlns:atc="x"><properties>` +
        `<property name="systemCheckVariant" value="DEFAULT"/></properties></atc:customizing>`,
    );
    expect(c.exemptionReasons).toEqual([]);
  });

  it("refuses a document that is not customizing at all", () => {
    try {
      parseAtcCustomizing("<html><body>Logon page</body></html>");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("ADT_ERROR");
    }
  });
});

describe("run acknowledgement", () => {
  it("reads the worklist id and timestamp from CHILD ELEMENTS", () => {
    const ack = parseAtcRunAck(RUN_ACK);
    expect(ack.worklistId).toBe("0A1B2C3D4E5F6789");
    expect(ack.timestamp).toBe("2026-08-18T09:30:00Z");
    expect(ack.infos).toEqual([]);
  });

  it("keeps a hex id that happens to be all digits as a string", () => {
    // `parseTagValue: false` earns its keep here: an all-digit worklist id is a
    // legal hex token, and coerced to a number it loses leading zeros and is
    // then spliced into two URLs.
    const ack = parseAtcRunAck(
      `<atc:worklistRun xmlns:atc="x"><atc:worklistId>00012345</atc:worklistId></atc:worklistRun>`,
    );
    expect(ack.worklistId).toBe("00012345");
    expect(typeof ack.worklistId).toBe("string");
  });

  it("reads infos in the child-element shape (INFERRED shape #1)", () => {
    expect(parseAtcRunAck(RUN_ACK_WITH_INFOS).infos).toEqual([
      { type: "WARNING", description: "Some checks were skipped for this object type." },
    ]);
  });

  it("reads infos in the attribute shape too (INFERRED shape #2)", () => {
    // Both shapes are read because neither has been observed. Dropping a server
    // remark over a guess about its shape is the failure mode being avoided.
    expect(parseAtcRunAck(RUN_ACK_ATTR_INFOS).infos).toEqual([
      { type: "WARNING", description: "Some checks were skipped." },
    ]);
  });

  it("does not collapse a single info to a bare object", () => {
    expect(Array.isArray(parseAtcRunAck(RUN_ACK_WITH_INFOS).infos)).toBe(true);
    expect(parseAtcRunAck(RUN_ACK_WITH_INFOS).infos).toHaveLength(1);
  });

  it("omits the timestamp when the server sends none", () => {
    const ack = parseAtcRunAck(
      `<atc:worklistRun xmlns:atc="x"><atc:worklistId>0A</atc:worklistId></atc:worklistRun>`,
    );
    expect(ack.timestamp).toBeUndefined();
  });

  it("refuses a response with no worklistRun root", () => {
    try {
      parseAtcRunAck(`<atc:somethingElse xmlns:atc="x"/>`);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("ADT_ERROR");
    }
  });
});

describe("worklist", () => {
  it("reads the root attributes", () => {
    const w = parseAtcWorklist(WORKLIST);
    expect(w.id).toBe("0A1B2C3D4E5F6789");
    expect(w.timestamp).toBe("2026-08-18T09:30:00Z");
    expect(w.usedObjectSet).toBe("RUN_00042");
    expect(w.objectSetIsComplete).toBe(true);
  });

  it("reads every object set with its kind", () => {
    expect(parseAtcWorklist(WORKLIST).objectSets).toEqual([
      { name: "ALL_OBJECTS", title: "All objects", kind: "COMPLETE" },
      { name: "RUN_00042", title: "Last run", kind: "LAST_RUN" },
    ]);
  });

  it("reads the object and both its findings", () => {
    const w = parseAtcWorklist(WORKLIST);
    expect(w.objects).toHaveLength(1);
    const obj = w.objects[0]!;
    expect(obj.name).toBe("ZCL_ORDER");
    expect(obj.type).toBe("CLAS/OC");
    expect(obj.packageName).toBe("ZDEMO");
    expect(obj.author).toBe("DEVELOPER");
    expect(obj.findings).toHaveLength(2);
  });

  it("splits the location fragment into line and column", () => {
    const f = parseAtcWorklist(WORKLIST).objects[0]!.findings[0]!;
    expect(f.location).toEqual({
      uri: "/sap/bc/adt/oo/classes/zcl_order/source/main",
      line: 42,
      column: 7,
    });
  });

  it("converts priority to a number exactly once", () => {
    const [a, b] = parseAtcWorklist(WORKLIST).objects[0]!.findings;
    expect(a?.priority).toBe(1);
    expect(b?.priority).toBe(3);
  });

  it("keeps a zero-padded messageId as a string", () => {
    // The hazard the house parser options exist for. `abap-adt-api` parses this
    // as a number and then stringifies it back, turning "0007" into "7".
    const f = parseAtcWorklist(WORKLIST).objects[0]!.findings[0]!;
    expect(f.messageId).toBe("0007");
  });

  it("preserves an empty exemptionKind rather than folding it to undefined", () => {
    // `""` is the discriminator between "not exempted" and "exempted": folding
    // it away would make every finding look potentially exempted.
    const [a, b] = parseAtcWorklist(WORKLIST).objects[0]!.findings;
    expect(a?.exemptionKind).toBe("");
    expect(b?.exemptionKind).toBe("A");
  });

  it("carries the quickfix token when present and omits it when not", () => {
    const [a, b] = parseAtcWorklist(WORKLIST).objects[0]!.findings;
    expect(a?.quickfixInfo).toBe("QF_0001");
    expect(b?.quickfixInfo).toBeUndefined();
  });

  it("does not collapse a one-object, one-finding worklist to bare objects", () => {
    // `fast-xml-parser` collapses one-element lists, and for ATC the singleton
    // is the COMMON case: one object checked, one thing wrong with it.
    const w = parseAtcWorklist(WORKLIST_SINGLETON);
    expect(Array.isArray(w.objects)).toBe(true);
    expect(w.objects).toHaveLength(1);
    expect(Array.isArray(w.objects[0]?.findings)).toBe(true);
    expect(w.objects[0]?.findings).toHaveLength(1);
    expect(w.objectSets).toHaveLength(1);
  });

  it("reads a clean worklist as zero findings, not as a failure", () => {
    const w = parseAtcWorklist(WORKLIST_EMPTY);
    expect(w.objects).toEqual([]);
    expect(flattenFindings(w)).toEqual([]);
  });

  it("treats a missing objectSetIsComplete as complete", () => {
    // Absent means complete. Defaulting the other way would stamp a false
    // "results may be truncated" warning on every clean run from any release
    // that omits the attribute.
    expect(parseAtcWorklist(WORKLIST_SINGLETON).objectSetIsComplete).toBe(true);
  });

  it("reads objectSetIsComplete=false as incomplete", () => {
    const truncated = WORKLIST.replace(
      'objectSetIsComplete="true"',
      'objectSetIsComplete="false"',
    );
    expect(parseAtcWorklist(truncated).objectSetIsComplete).toBe(false);
  });

  it("refuses a response with no worklist root", () => {
    try {
      parseAtcWorklist(`<atc:notAWorklist xmlns:atc="x"/>`);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("ADT_ERROR");
    }
  });
});

describe("flattenFindings", () => {
  it("attaches the object identity to every finding", () => {
    const flat = flattenFindings(parseAtcWorklist(WORKLIST));
    expect(flat).toHaveLength(2);
    for (const f of flat) {
      expect(f.objectName).toBe("ZCL_ORDER");
      expect(f.objectType).toBe("CLAS/OC");
      expect(f.packageName).toBe("ZDEMO");
    }
  });

  it("sorts most severe first, so truncation drops notes before errors", () => {
    const flat = flattenFindings(parseAtcWorklist(WORKLIST));
    expect(flat.map((f) => f.priority)).toEqual([1, 3]);
  });

  it("sorts an unknown priority last, not first", () => {
    // A naive ascending numeric sort would put priority 0 — "the server did not
    // say" — above every real error.
    const doc = WORKLIST.replace('priority="1"', 'priority=""');
    const flat = flattenFindings(parseAtcWorklist(doc));
    expect(flat.map((f) => f.priority)).toEqual([3, 0]);
  });

  it("breaks ties deterministically by object, then line, then check", () => {
    const doc = WORKLIST_SINGLETON.replace(
      "</atcworklist:findings>",
      `<atcworklist:finding uri="/f/2" location="/x/source/main#start=1,1"
          priority="2" checkId="A" checkTitle="A" messageId="2" messageTitle="M2"
          exemptionApproval="" exemptionKind=""/></atcworklist:findings>`,
    );
    const flat = flattenFindings(parseAtcWorklist(doc));
    expect(flat.map((f) => f.checkId)).toEqual(["A", "C"]);
  });
});

describe("countFindings", () => {
  it("tallies by priority and counts exemptions separately", () => {
    const c = countFindings(flattenFindings(parseAtcWorklist(WORKLIST)));
    expect(c).toEqual({
      total: 2,
      errors: 1,
      warnings: 0,
      infos: 1,
      other: 0,
      exempted: 1,
    });
  });

  it("counts an unrecognised priority as `other` rather than dropping it", () => {
    const doc = WORKLIST.replace('priority="3"', 'priority="9"');
    const c = countFindings(flattenFindings(parseAtcWorklist(doc)));
    expect(c.other).toBe(1);
    expect(c.total).toBe(2);
  });

  it("is all zeros for a clean run", () => {
    expect(countFindings(flattenFindings(parseAtcWorklist(WORKLIST_EMPTY)))).toEqual({
      total: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      other: 0,
      exempted: 0,
    });
  });
});

// =========================================================== live captures ===
// Real ADT responses from an A4H appliance, `test/fixtures/live-captured/`.

describe("live capture: 439-atc2-worklist-read.xml (worklist, one finding)", () => {
  const w = parseAtcWorklist(readLiveFixture("439-atc2-worklist-read.xml"));

  it("reads the root attributes", () => {
    expect(w.id).toBe("1A2263E0A4E31FE1A3B02FDDF4887650");
    expect(w.timestamp).toBe("2026-08-01T08:18:09Z");
    expect(w.usedObjectSet).toBe("99999999999999999999999999999999");
    expect(w.objectSetIsComplete).toBe(true);
  });

  it("reads both object sets (ALL and LAST_RUN)", () => {
    expect(w.objectSets).toEqual([
      { name: "00000000000000000000000000000000", title: "All Objects", kind: "ALL" },
      {
        name: "99999999999999999999999999999999",
        title: "Last Check Run",
        kind: "LAST_RUN",
      },
    ]);
  });

  it("reads the one object and its one finding without collapsing to bare objects", () => {
    expect(w.objects).toHaveLength(1);
    const obj = w.objects[0]!;
    expect(obj.name).toBe("ZMCP_ATC_PROBE2");
    expect(obj.type).toBe("PROG");
    expect(obj.packageName).toBe("$TMP");
    expect(obj.author).toBe("DEVELOPER");
    expect(obj.objectTypeId).toBe("PROG/P");
    expect(obj.findings).toHaveLength(1);
  });

  it("reads the finding's fields, including the documentation link", () => {
    const f = w.objects[0]!.findings[0]!;
    expect(f.uri).toBe(
      "/sap/bc/adt/atc/findings/itemid/1A2263E0A4E31FE1A3B030D34A99D650/index/3",
    );
    expect(f.priority).toBe(2);
    expect(f.checkId).toBe("F8607CD40A0F8B30BDF8590205B306E8");
    expect(f.checkTitle).toBe("Extended Program Check (SLIN)");
    expect(f.messageId).toBe("0800");
    expect(f.messageTitle).toBe("The line contains a BREAK-POINT statement.");
    expect(f.exemptionKind).toBe("");
    expect(f.exemptionApproval).toBe("");
    expect(f.quickfixInfo).toBe("atc:1A2263E0A4E31FE1A3B030D34A99D650,3");
    expect(f.documentationUri).toBe(
      "/sap/bc/adt/documentation/atc/documents/itemid/1A2263E0A4E31FE1A3B030D34A99D650/index/3",
    );
  });

  it("has no <quickfixes> element on this release, so quickFixes is absent", () => {
    expect(w.objects[0]!.findings[0]!.quickFixes).toBeUndefined();
  });
});

describe("live capture: 888-i78-worklist-read-two-packages.xml (29 findings, 5 objects, 2 packages)", () => {
  const w = parseAtcWorklist(
    readLiveFixture("888-i78-worklist-read-two-packages.xml"),
  );

  it("has no root timestamp on this response", () => {
    expect(w.timestamp).toBeUndefined();
  });

  it("reads all 5 objects with their package names", () => {
    expect(w.objects).toHaveLength(5);
    expect(w.objects.map((o) => [o.name, o.packageName])).toEqual([
      ["ZCL_PUBLISH_SRVB_LOCALLY", "Z_FLIGHT_REF_PREP"],
      ["ZCL_UPG_SU_BADI_CH_MU", "Z_UPG_BADI_IMPL"],
      ["Z_UPG_SINGLEUSE_BADI_FALLBACK", "Z_UPG_BADI_IMPL"],
      ["Z_UPG_SINGLEUSE_BADI_CHANGE_MU", "Z_UPG_BADI_IMPL"],
      ["Z_UPG_SINGLEUSE_BADI_FALLBACK", "Z_UPG_BADI_IMPL"],
    ]);
  });

  it("reads a CLAS object's type without the /OC suffix", () => {
    expect(w.objects[0]!.type).toBe("CLAS");
  });

  it("reads a finding's documentation link", () => {
    const f = w.objects[0]!.findings[0]!;
    expect(f.documentationUri).toBe(
      "/sap/bc/adt/documentation/atc/documents/itemid/466F46C806601FE1ABD7F79173A2C069/index/14",
    );
  });

  it("reads quickFixes as present but all false, with any computed false", () => {
    for (const obj of w.objects) {
      for (const f of obj.findings) {
        expect(f.quickFixes).toEqual({
          manual: false,
          automatic: false,
          pseudo: false,
          aiBased: false,
          aiEnabled: false,
          any: false,
        });
        // quickfixInfo is a different claim and stays present regardless.
        expect(f.quickfixInfo).toBeDefined();
      }
    }
  });

  it("flattens and counts all 29 findings across the whole document", () => {
    const flat = flattenFindings(w);
    expect(flat).toHaveLength(29);
    const counts = countFindings(flat);
    expect(counts).toEqual({
      total: 29,
      errors: 19,
      warnings: 0,
      infos: 10,
      other: 0,
      exempted: 0,
    });
  });
});

describe("live capture: 889-i78-worklist-read-lastrun-empty.xml (empty worklist, five object sets)", () => {
  const w = parseAtcWorklist(
    readLiveFixture("889-i78-worklist-read-lastrun-empty.xml"),
  );

  it("reads zero objects, not a failure", () => {
    expect(w.objects).toEqual([]);
    expect(flattenFindings(w)).toEqual([]);
  });

  it("reads all five object sets, three of them PACKAGE", () => {
    expect(w.objectSets).toHaveLength(5);
    const packageSets = w.objectSets.filter((s) => s.kind === "PACKAGE");
    expect(packageSets).toHaveLength(3);
    expect(w.objectSets.map((s) => s.kind)).toEqual([
      "ALL",
      "LAST_RUN",
      "PACKAGE",
      "PACKAGE",
      "PACKAGE",
    ]);
  });

  it("reports objectSetIsComplete true", () => {
    expect(w.objectSetIsComplete).toBe(true);
  });
});

describe("live capture: 890-i78-worklist-read-variant2.xml (5 findings, one PROG object)", () => {
  const w = parseAtcWorklist(readLiveFixture("890-i78-worklist-read-variant2.xml"));

  it("reads the one object and all 5 findings", () => {
    expect(w.objects).toHaveLength(1);
    const obj = w.objects[0]!;
    expect(obj.name).toBe("Z_TMP_DEL");
    expect(obj.type).toBe("PROG");
    expect(obj.findings).toHaveLength(5);
  });
});

describe("live capture: 886-i78-checkvariants-quicksearch.xml (parseCheckVariantList)", () => {
  const variants = parseCheckVariantList(
    readLiveFixture("886-i78-checkvariants-quicksearch.xml"),
  );

  it("returns all 19 variants in the server's order", () => {
    expect(variants).toHaveLength(19);
    expect(variants[0]).toEqual({
      name: "ABAP_CLEAN_CORE_DEVELOPMENT",
      uri: "/sap/bc/adt/atc/checkvariants/abap_clean_core_development",
      description: "Variant for clean core development",
      packageName: "SYCM_3TIER_MODEL",
    });
  });

  it("includes ZABAP_CLOUD_DEVELOPMENT with its uri/description/packageName", () => {
    const zabap = variants.find((v) => v.name === "ZABAP_CLOUD_DEVELOPMENT");
    expect(zabap).toEqual({
      name: "ZABAP_CLOUD_DEVELOPMENT",
      uri: "/sap/bc/adt/atc/checkvariants/zabap_cloud_development",
      description: "Default ATC variant for ABAP Cloud Development",
      packageName: "$TMP",
    });
  });

  it("filters out a row whose type is not CHKV (SYNTHETIC row appended to a real document)", () => {
    // The real 886 capture has no non-CHKV rows — this exercises the filter
    // that makes the result trustworthy if quickSearch is ever broadened.
    const real = readLiveFixture("886-i78-checkvariants-quicksearch.xml");
    const withExtra = real.replace(
      "</adtcore:objectReferences>",
      '<adtcore:objectReference adtcore:uri="/sap/bc/adt/oo/classes/zcl_foo" ' +
        'adtcore:type="CLAS/OC" adtcore:name="ZCL_FOO"/></adtcore:objectReferences>',
    );
    const mixed = parseCheckVariantList(withExtra);
    expect(mixed).toHaveLength(19);
    expect(mixed.some((v) => v.name === "ZCL_FOO")).toBe(false);
  });

  it("does not throw on an empty list", () => {
    const empty = parseCheckVariantList(
      '<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"/>',
    );
    expect(empty).toEqual([]);
  });

  it("refuses a document with no objectReferences root", () => {
    try {
      parseCheckVariantList('<adtcore:somethingElse xmlns:adtcore="x"/>');
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(isAbapError(e) && e.code).toBe("ADT_ERROR");
    }
  });
});

describe("live capture: 893-i78-atc-customizing.xml (parseAtcCustomizing)", () => {
  it("reads systemCheckVariant as ZABAP_CLOUD_DEVELOPMENT", () => {
    const c = parseAtcCustomizing(readLiveFixture("893-i78-atc-customizing.xml"));
    expect(systemCheckVariant(c, SYSTEM_CHECK_VARIANT_PROPERTY)).toBe(
      "ZABAP_CLOUD_DEVELOPMENT",
    );
  });
});

describe("live capture: 887-i78-run-two-packages.xml (parseAtcRunAck)", () => {
  it("reads the worklist id, timestamp, and both infos", () => {
    const ack = parseAtcRunAck(readLiveFixture("887-i78-run-two-packages.xml"));
    expect(ack.worklistId).toBe("466F46C806601FE1ABD795A0C0B5C069");
    expect(ack.timestamp).toBe("2026-09-12T15:48:31Z");
    expect(ack.infos).toEqual([
      {
        type: "TOOL_FAILURE",
        description: "Check not executable, due to missing prerequisites",
      },
      { type: "FINDING_STATS", description: "32,0,47" },
    ]);
  });
});
