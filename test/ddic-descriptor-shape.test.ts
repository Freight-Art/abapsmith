/**
 * Pins `ddicDescriptorSkeleton`/`assertDdicDescriptorShape` —
 * the pre-send root-identity check for the three XML-only DDIC writes
 * (`DOMA/DD`, `DTEL/DE`, `TTYP/DA`) and the known-accepted skeletons it
 * hands out. See `src/adt/ddic-payload.ts`'s module doc for the two live
 * failure classes this guards: wrong root element/namespace (many rejected
 * round trips) and DTEL's two-namespace trap (a silent `abap.(0)` corruption
 * that reads back `ok:true`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDdicDescriptorShape, ddicDescriptorSkeleton } from "../src/adt/ddic-payload.js";
import { isAbapError } from "../src/adt/errors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE_FIXTURES = join(HERE, "fixtures", "live-captured");
const DTEL_XML_LIVE = readFileSync(join(LIVE_FIXTURES, "844-live-dtel-s-carr-id.xml"), "utf8");
const DOMA_XML_LIVE = readFileSync(join(LIVE_FIXTURES, "845-live-doma-s-carr-id.xml"), "utf8");
const SKILL_MD = readFileSync(join(HERE, "..", "skills", "abapsmith-create-ddic-objects", "SKILL.md"), "utf8");

/** Fenced code block immediately following `**\`TYPE\`**` under the skill's `## Skeletons` heading. */
function extractSkillSkeleton(skillMd: string, type: string): string | undefined {
  const re = new RegExp("\\*\\*`" + type.replace("/", "\\/") + "`\\*\\*\\s*\\n\\n```\\n([\\s\\S]*?)\\n```");
  return re.exec(skillMd)?.[1];
}

describe("ddicDescriptorSkeleton", () => {
  it("returns undefined for a type outside the three XML-only DDIC types", () => {
    expect(ddicDescriptorSkeleton("CLAS/OC", "ZFOO")).toBeUndefined();
    expect(ddicDescriptorSkeleton("PROG/P", "ZFOO")).toBeUndefined();
  });

  it("substitutes the requested name into adtcore:name for all three types", () => {
    expect(ddicDescriptorSkeleton("DOMA/DD", "ZDOM_TEST")).toContain('adtcore:name="ZDOM_TEST"');
    expect(ddicDescriptorSkeleton("DTEL/DE", "ZDE_TEST")).toContain('adtcore:name="ZDE_TEST"');
    expect(ddicDescriptorSkeleton("TTYP/DA", "ZTT_TEST")).toContain('adtcore:name="ZTT_TEST"');
  });

  it("does not let a name containing '$&' corrupt the skeleton via String.replace's special replacement patterns", () => {
    const xml = ddicDescriptorSkeleton("DOMA/DD", "$&FOO");
    expect(xml).toContain('adtcore:name="$&amp;FOO"');
    expect(xml).not.toContain('adtcore:name="NAME"');
  });
});

describe("assertDdicDescriptorShape — the three skeletons pass their own check", () => {
  it("DOMA/DD skeleton passes unchanged", () => {
    const xml = ddicDescriptorSkeleton("DOMA/DD", "ZDOM_TEST")!;
    expect(() => assertDdicDescriptorShape("DOMA/DD", "ZDOM_TEST", xml)).not.toThrow();
  });

  it("TTYP/DA skeleton passes unchanged", () => {
    const xml = ddicDescriptorSkeleton("TTYP/DA", "ZTT_TEST")!;
    expect(() => assertDdicDescriptorShape("TTYP/DA", "ZTT_TEST", xml)).not.toThrow();
  });

  it("DTEL/DE skeleton passes unchanged", () => {
    const xml = ddicDescriptorSkeleton("DTEL/DE", "ZDE_TEST")!;
    expect(() => assertDdicDescriptorShape("DTEL/DE", "ZDE_TEST", xml)).not.toThrow();
  });

  it("the DTEL skeleton's inner dtel: prefix resolves to a DIFFERENT namespace than the root blue: prefix", () => {
    const xml = ddicDescriptorSkeleton("DTEL/DE", "ZDE_TEST")!;
    const rootNsMatch = /xmlns:blue="([^"]+)"/.exec(xml);
    const innerNsMatch = /xmlns:dtel="([^"]+)"/.exec(xml);
    expect(rootNsMatch?.[1]).toBe("http://www.sap.com/wbobj/dictionary/dtel");
    expect(innerNsMatch?.[1]).toBe("http://www.sap.com/adt/dictionary/dataelements");
    expect(innerNsMatch?.[1]).not.toBe(rootNsMatch?.[1]);
  });
});

describe("assertDdicDescriptorShape — real captured wrong payloads are refused", () => {
  it("refuses a TTYP/DA root bound to the guessed .../adt/dictionary/tabletypes namespace", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><ttyp:tableType ' +
      'xmlns:ttyp="http://www.sap.com/adt/dictionary/tabletypes" xmlns:adtcore="http://www.sap.com/adt/core" ' +
      'adtcore:name="ZTT_TEST" adtcore:type="TTYP/DA"><adtcore:packageRef adtcore:name="$TMP"/></ttyp:tableType>';
    let thrown: unknown;
    try {
      assertDdicDescriptorShape("TTYP/DA", "ZTT_TEST", xml);
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    const text = `${isAbapError(thrown) ? thrown.message : ""} ${isAbapError(thrown) ? thrown.hint : ""}`;
    expect(text).toContain("http://www.sap.com/dictionary/tabletype");
    expect(isAbapError(thrown) ? thrown.details.ddicSkeleton : undefined).toBe(
      ddicDescriptorSkeleton("TTYP/DA", "ZTT_TEST"),
    );
  });

  it("refuses a TTYP/DA root named tabletype (lowercase t) bound to the guessed wbobj/dictionary/ttyp namespace", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><ttyp:tabletype ' +
      'xmlns:ttyp="http://www.sap.com/wbobj/dictionary/ttyp" xmlns:adtcore="http://www.sap.com/adt/core" ' +
      'adtcore:name="ZTT_TEST" adtcore:type="TTYP/DA"><adtcore:packageRef adtcore:name="$TMP"/></ttyp:tabletype>';
    let thrown: unknown;
    try {
      assertDdicDescriptorShape("TTYP/DA", "ZTT_TEST", xml);
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    const text = `${isAbapError(thrown) ? thrown.message : ""} ${isAbapError(thrown) ? thrown.hint : ""}`;
    expect(text).toContain("tableType");
    expect(text).toContain("http://www.sap.com/dictionary/tabletype");
  });

  it("refuses a DOMA/DD root with the correct local name bound to the guessed .../adt/dictionary/domains namespace", () => {
    const name = "ZDOM_TEST";
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><doma:domain ' +
      'xmlns:doma="http://www.sap.com/adt/dictionary/domains" xmlns:adtcore="http://www.sap.com/adt/core" ' +
      `adtcore:name="${name}" adtcore:type="DOMA/DD"><adtcore:packageRef adtcore:name="$TMP"/></doma:domain>`;
    let thrown: unknown;
    try {
      assertDdicDescriptorShape("DOMA/DD", name, xml);
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    const text = `${isAbapError(thrown) ? thrown.message : ""} ${isAbapError(thrown) ? thrown.hint : ""}`;
    expect(text).toContain("http://www.sap.com/dictionary/domain");
    expect(isAbapError(thrown) ? thrown.details.ddicSkeleton : undefined).toBe(
      ddicDescriptorSkeleton("DOMA/DD", name),
    );
  });

  it("refuses the DTEL silent-corruption case: inner dataElement bound to the root's own namespace", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDE_TEST" adtcore:type="DTEL/DE">' +
      '<adtcore:packageRef adtcore:name="$TMP"/>' +
      '<dtel:dataElement xmlns:dtel="http://www.sap.com/wbobj/dictionary/dtel">' +
      "<dtel:typeKind>domain</dtel:typeKind></dtel:dataElement></blue:wbobj>";
    let thrown: unknown;
    try {
      assertDdicDescriptorShape("DTEL/DE", "ZDE_TEST", xml);
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
    const text = `${isAbapError(thrown) ? thrown.message : ""} ${isAbapError(thrown) ? thrown.hint : ""}`;
    expect(text).toContain("http://www.sap.com/adt/dictionary/dataelements");
    expect(text).toContain("abap.(0)");
    expect(text).toMatch(/accepted/i);
    expect(isAbapError(thrown) ? thrown.details.ddicSkeleton : undefined).toBe(
      ddicDescriptorSkeleton("DTEL/DE", "ZDE_TEST"),
    );
  });
});

describe("assertDdicDescriptorShape — resolves the root's default namespace (no prefix)", () => {
  it("accepts a DOMA/DD root declaring its namespace via a default (unprefixed) xmlns", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><domain xmlns="http://www.sap.com/dictionary/domain" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDOM_TEST" adtcore:type="DOMA/DD">' +
      "<adtcore:packageRef adtcore:name=\"$TMP\"/></domain>";
    expect(() => assertDdicDescriptorShape("DOMA/DD", "ZDOM_TEST", xml)).not.toThrow();
  });

  it("refuses a DOMA/DD root declaring the wrong URI via a default (unprefixed) xmlns", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><domain xmlns="http://wrong" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDOM_TEST" adtcore:type="DOMA/DD">' +
      "<adtcore:packageRef adtcore:name=\"$TMP\"/></domain>";
    let thrown: unknown;
    try {
      assertDdicDescriptorShape("DOMA/DD", "ZDOM_TEST", xml);
    } catch (e) {
      thrown = e;
    }
    expect(isAbapError(thrown) && thrown.code).toBe("BAD_INPUT");
  });
});

describe("assertDdicDescriptorShape — fails open when it cannot prove anything", () => {
  it("does nothing for a type that isn't one of the three XML-only DDIC types", () => {
    const xml = "<clas:class><nonsense/></clas:class>";
    expect(() => assertDdicDescriptorShape("CLAS/OC", "ZCL_FOO", xml)).not.toThrow();
  });

  it("does nothing when the root element's prefix is never bound to any namespace", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><doma:domain adtcore:name="ZDOM_TEST" ' +
      'adtcore:type="DOMA/DD" xmlns:adtcore="http://www.sap.com/adt/core">' +
      "<adtcore:packageRef adtcore:name=\"$TMP\"/></doma:domain>";
    expect(() => assertDdicDescriptorShape("DOMA/DD", "ZDOM_TEST", xml)).not.toThrow();
  });

  it("does nothing for a DTEL/DE payload with a correct root but no dataElement element at all", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel" ' +
      'xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="ZDE_TEST" adtcore:type="DTEL/DE">' +
      '<adtcore:packageRef adtcore:name="$TMP"/></blue:wbobj>';
    expect(() => assertDdicDescriptorShape("DTEL/DE", "ZDE_TEST", xml)).not.toThrow();
  });

  it("does nothing for a payload that is not XML at all", () => {
    expect(() => assertDdicDescriptorShape("DOMA/DD", "ZDOM_TEST", "not xml at all")).not.toThrow();
    expect(() => assertDdicDescriptorShape("DOMA/DD", "ZDOM_TEST", "")).not.toThrow();
  });

  it("does not trigger on a wrong namespace that appears only inside a comment before a correct root", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><!-- <ttyp:tabletype xmlns:ttyp="http://wrong"/> --><ttyp:tableType ' +
      'xmlns:ttyp="http://www.sap.com/dictionary/tabletype" xmlns:adtcore="http://www.sap.com/adt/core" ' +
      'adtcore:name="ZTT_TEST" adtcore:type="TTYP/DA"><adtcore:packageRef adtcore:name="$TMP"/></ttyp:tableType>';
    expect(() => assertDdicDescriptorShape("TTYP/DA", "ZTT_TEST", xml)).not.toThrow();
  });
});

describe("assertDdicDescriptorShape — live-captured fixtures pass for their own types", () => {
  it("accepts the real captured DTEL/DE S_CARR_ID GET body", () => {
    expect(() => assertDdicDescriptorShape("DTEL/DE", "S_CARR_ID", DTEL_XML_LIVE)).not.toThrow();
  });

  it("accepts the real captured DOMA/DD S_CARR_ID GET body", () => {
    expect(() => assertDdicDescriptorShape("DOMA/DD", "S_CARR_ID", DOMA_XML_LIVE)).not.toThrow();
  });
});

describe("SKILL.md's hand-copied skeletons stay byte-identical to the exported ones", () => {
  // Pins two hand-maintained copies of the same bytes together so a stale skill skeleton fails loudly instead of silently drifting.
  it("finds all three skill skeletons and matches each against ddicDescriptorSkeleton", () => {
    const cases: Array<{ type: string; name: string }> = [
      { type: "DOMA/DD", name: "ZDOM_EXAMPLE" },
      { type: "DTEL/DE", name: "ZDE_EXAMPLE" },
      { type: "TTYP/DA", name: "ZTT_EXAMPLE" },
    ];
    const extracted = cases.map(({ type }) => extractSkillSkeleton(SKILL_MD, type));
    expect(extracted.filter((block) => block !== undefined)).toHaveLength(3);
    cases.forEach(({ type, name }, i) => {
      expect(extracted[i]).toBe(ddicDescriptorSkeleton(type, name));
    });
  });
});
