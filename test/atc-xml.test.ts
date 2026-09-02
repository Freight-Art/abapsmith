/**
 * `src/adt/atc-xml.ts` — ATC response parsing.
 *
 * ## Every document in this file is SYNTHETIC. It is not a recording.
 *
 * `doc/TESTING/README.md` and `CONTRIBUTING.md` are explicit that a fixture stops
 * being a check against reality the moment it is invented, so none of the XML
 * below is presented as a capture and none of it lives under `test/fixtures/`.
 * There are no ATC captures anywhere in this repo, and none in `abap-adt-api`
 * either — its ATC tests are live-only and record nothing.
 *
 * These documents are **doubles built to the shape `abap-adt-api` v8.4.1's ATC
 * client reads** (`build/api/atc.js`) and validates with io-ts
 * (`build/api/atc.d.ts`). That decoder is the strongest offline evidence
 * available for the attribute names: it runs on every response that library
 * parses, so a wrong required field in it would have broken its users. It is
 * still not the same thing as having seen a server's bytes.
 *
 * So what these tests prove is: **given a document of that shape, this parser
 * extracts these values.** They do not prove SAP emits that shape. What a live
 * run would settle is listed in `doc/TOOLS/abap-atc.md`; the specific unknowns exercised
 * here and flagged in-place are the `<info>` element-vs-attribute shape and
 * whether `objectSetIsComplete` is always present.
 *
 * The tests that carry real weight regardless of provenance are the ones about
 * TYPE COERCION — zero-padded ids surviving as strings, one-element collections
 * not collapsing to objects. Those are properties of `fast-xml-parser`, not of
 * SAP, and they hold whatever the server sends.
 */
import { describe, expect, it } from "vitest";
import {
  countFindings,
  flattenFindings,
  parseAtcCustomizing,
  parseAtcRunAck,
  parseAtcWorklist,
  systemCheckVariant,
} from "../src/adt/atc-xml.js";
import { SYSTEM_CHECK_VARIANT_PROPERTY } from "../src/adt/atc-query.js";
import { isAbapError } from "../src/adt/errors.js";

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
