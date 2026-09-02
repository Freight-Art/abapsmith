/**
 * `src/adt/atc-query.ts` — ATC request building.
 *
 * ## Everything in this file is SYNTHETIC. Read this before trusting it.
 *
 * There are no captured ATC responses in this repo and none in `abap-adt-api`
 * either (its `restcalls/*.http` recordings contain zero ATC requests, and its
 * ATC tests are live-only with no recorded XML). Nothing below was replayed
 * from a real system, and no assertion here is evidence that SAP accepts what
 * this module sends.
 *
 * What these tests DO establish is agreement with the one written-down
 * description of this protocol that exists: `abap-adt-api` v8.4.1's ATC client
 * (`node_modules/abap-adt-api/build/api/atc.js`). Several tests below quote its
 * template literally and assert byte equality, which is the strongest check
 * available offline — it will fail loudly if someone "tidies" the run body.
 *
 * A live run would confirm or refute: that the server accepts the run body at
 * all, that `timestamp` round-trips through `Date` without loss, that
 * `usedObjectSet` scoping behaves as the library's own test implies, and
 * whether an unencoded variant name was ever load-bearing.
 */
import { describe, expect, it } from "vitest";
import {
  ATC_CUSTOMIZING_PATH,
  ATC_DEFAULT_MAX_VERDICTS,
  ATC_LAST_RUN_KIND,
  ATC_MAX_VERDICTS,
  ATC_RUNS_PATH,
  ATC_WORKLISTS_PATH,
  assertVariantName,
  assertWorklistId,
  atcTimestampSeconds,
  buildAtcRunBody,
  buildRunUrl,
  buildWorklistCreateUrl,
  buildWorklistReadUrl,
  clampMaxVerdicts,
  lastRunObjectSet,
  parseAtcLocation,
  priorityLabel,
} from "../src/adt/atc-query.js";
import { isAbapError } from "../src/adt/errors.js";

/**
 * The run body template exactly as `abap-adt-api@8.4.1` builds it
 * (`build/api/atc.js:232-246`), reproduced here as the reference this module
 * must match. TAB indentation is literal and load-bearing: the string below is
 * a copy, not a re-formatting.
 *
 * SYNTHETIC in the sense that it is a copy of a client's template rather than
 * a capture of a request a server accepted — but it is not invented.
 */
function libraryRunBody(uri: string, maxResults: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<atc:run maximumVerdicts="${maxResults}" xmlns:atc="http://www.sap.com/adt/atc">
\t<objectSets xmlns:adtcore="http://www.sap.com/adt/core">
\t\t<objectSet kind="inclusive">
\t\t\t<adtcore:objectReferences>
\t\t\t\t<adtcore:objectReference adtcore:uri="${uri}"/>
\t\t\t</adtcore:objectReferences>
\t\t</objectSet>
\t</objectSets>
</atc:run>`;
}

// ===========================================================================

describe("paths", () => {
  it("are the three ATC collections the library uses, spelled its way", () => {
    expect(ATC_CUSTOMIZING_PATH).toBe("/sap/bc/adt/atc/customizing");
    expect(ATC_WORKLISTS_PATH).toBe("/sap/bc/adt/atc/worklists");
    expect(ATC_RUNS_PATH).toBe("/sap/bc/adt/atc/runs");
  });

  it("worklists is plural and runs is plural — the two are separate collections", () => {
    // Guards the transposition that would otherwise be silent: POSTing a run to
    // the worklists collection creates a worklist instead of running anything.
    expect(ATC_RUNS_PATH).not.toBe(ATC_WORKLISTS_PATH);
    expect(ATC_WORKLISTS_PATH.endsWith("/worklists")).toBe(true);
    expect(ATC_RUNS_PATH.endsWith("/runs")).toBe(true);
  });
});

describe("the run body", () => {
  it("is byte-identical to the library's template", () => {
    const uri = "/sap/bc/adt/oo/classes/zcl_order/source/main";
    expect(buildAtcRunBody(uri, 100)).toBe(libraryRunBody(uri, 100));
  });

  it("keeps the literal tab indentation", () => {
    const body = buildAtcRunBody("/sap/bc/adt/programs/programs/zprog/source/main", 25);
    expect(body).toContain("\n\t<objectSets");
    expect(body).toContain("\n\t\t<objectSet ");
    expect(body).toContain("\n\t\t\t\t<adtcore:objectReference ");
    // No space-indented variant crept in.
    expect(body).not.toContain("\n  <objectSets");
  });

  it("has no trailing newline, matching the template", () => {
    expect(buildAtcRunBody("/x", 1).endsWith("</atc:run>")).toBe(true);
  });

  it("carries exactly one objectSet and one objectReference", () => {
    const body = buildAtcRunBody("/sap/bc/adt/oo/classes/zcl_a/source/main", 100);
    expect(body.match(/<objectSet /g)).toHaveLength(1);
    expect(body.match(/<adtcore:objectReference /g)).toHaveLength(1);
  });

  it("substitutes the clamped verdict count, not the requested one", () => {
    expect(buildAtcRunBody("/x", 99_999)).toContain(
      `maximumVerdicts="${ATC_MAX_VERDICTS}"`,
    );
    expect(buildAtcRunBody("/x", 0)).toContain('maximumVerdicts="1"');
  });

  it("refuses a URI that would break out of the XML attribute", () => {
    // The library interpolates this unescaped. Rather than add escaping nobody
    // has seen a server accept, refuse — no legitimate ADT URI contains these.
    for (const bad of ['/x"/>', "/x<y", "/x&y"]) {
      expect(() => buildAtcRunBody(bad, 100)).toThrowError();
      try {
        buildAtcRunBody(bad, 100);
      } catch (e) {
        expect(isAbapError(e) && e.code).toBe("BAD_INPUT");
      }
    }
  });

  it("refuses an empty object URI rather than running against nothing", () => {
    expect(() => buildAtcRunBody("", 100)).toThrowError();
    expect(() => buildAtcRunBody("   ", 100)).toThrowError();
  });
});

describe("clampMaxVerdicts", () => {
  it("defaults to the library's own default", () => {
    expect(clampMaxVerdicts(undefined)).toBe(ATC_DEFAULT_MAX_VERDICTS);
    expect(ATC_DEFAULT_MAX_VERDICTS).toBe(100);
  });

  it("bounds both ends and truncates fractions", () => {
    expect(clampMaxVerdicts(0)).toBe(1);
    expect(clampMaxVerdicts(-5)).toBe(1);
    expect(clampMaxVerdicts(10.9)).toBe(10);
    expect(clampMaxVerdicts(ATC_MAX_VERDICTS + 1)).toBe(ATC_MAX_VERDICTS);
    expect(clampMaxVerdicts(Number.NaN)).toBe(ATC_DEFAULT_MAX_VERDICTS);
  });
});

describe("URL building", () => {
  it("creates a worklist with the variant as a query parameter", () => {
    expect(buildWorklistCreateUrl("DEFAULT")).toBe(
      "/sap/bc/adt/atc/worklists?checkVariant=DEFAULT",
    );
  });

  it("encodes the variant, which the library does not", () => {
    // Documented divergence. `/` is legal in an ABAP namespaced name and is the
    // realistic case; unencoded it changes the URL's path structure.
    expect(buildWorklistCreateUrl("/ABC/VARIANT")).toBe(
      "/sap/bc/adt/atc/worklists?checkVariant=%2FABC%2FVARIANT",
    );
  });

  it("runs against a worklist id, under the runs collection", () => {
    expect(buildRunUrl("0A1B2C3D")).toBe(
      "/sap/bc/adt/atc/runs?worklistId=0A1B2C3D",
    );
  });

  it("reads a worklist by id, always stating includeExemptedFindings", () => {
    // The library sends `false` on the wire because axios drops `undefined` but
    // not `false`. Reproduced rather than "improved".
    expect(buildWorklistReadUrl("0A1B")).toBe(
      "/sap/bc/adt/atc/worklists/0A1B?includeExemptedFindings=false",
    );
    expect(buildWorklistReadUrl("0A1B", { includeExempted: true })).toBe(
      "/sap/bc/adt/atc/worklists/0A1B?includeExemptedFindings=true",
    );
  });

  it("adds timestamp and usedObjectSet when scoping to a run", () => {
    const url = buildWorklistReadUrl("0A1B", {
      timestamp: 1_700_000_000,
      usedObjectSet: "LAST_RUN_SET",
    });
    const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(qs.get("timestamp")).toBe("1700000000");
    expect(qs.get("usedObjectSet")).toBe("LAST_RUN_SET");
    expect(qs.get("includeExemptedFindings")).toBe("false");
  });

  it("omits a NaN timestamp rather than sending it", () => {
    const url = buildWorklistReadUrl("0A1B", { timestamp: Number.NaN });
    expect(url).not.toContain("timestamp");
  });

  it("omits an empty usedObjectSet", () => {
    expect(buildWorklistReadUrl("0A1B", { usedObjectSet: "" })).not.toContain(
      "usedObjectSet",
    );
  });
});

describe("validation of values that get spliced into URLs", () => {
  it("accepts realistic variant names", () => {
    for (const good of ["DEFAULT", "ABAP_CLOUD_READINESS", "/ABC/MY-VARIANT", "Z_V1"]) {
      expect(() => assertVariantName(good)).not.toThrow();
    }
  });

  it("refuses a variant that could reshape the request", () => {
    for (const bad of ["", "A&checkVariant=B", "A B", "../../etc", "9LEADING"]) {
      expect(() => assertVariantName(bad)).toThrowError();
    }
  });

  it("accepts a hex worklist id, the only form ever observed", () => {
    expect(() => assertWorklistId("0A1B2C3D4E5F")).not.toThrow();
  });

  it("refuses a worklist id containing URL syntax, and blames the server", () => {
    try {
      assertWorklistId("abc?x=1");
      expect.unreachable("should have thrown");
    } catch (e) {
      // Not BAD_INPUT: the id is a server response, not something the caller
      // typed, so a message telling the caller to fix their input would send
      // them looking in the wrong place.
      expect(isAbapError(e) && e.code).toBe("ADT_ERROR");
    }
  });
});

describe("lastRunObjectSet", () => {
  it("finds the set whose kind is LAST_RUN", () => {
    const sets = [
      { name: "ALL", kind: "COMPLETE" },
      { name: "RUN_42", kind: ATC_LAST_RUN_KIND },
    ];
    expect(lastRunObjectSet(sets)?.name).toBe("RUN_42");
  });

  it("returns undefined rather than guessing when no set says LAST_RUN", () => {
    // `undefined` is a real answer: it means the read cannot be narrowed, and
    // the caller must say so instead of presenting an accumulated worklist as
    // one run's output.
    expect(lastRunObjectSet([{ name: "ALL", kind: "COMPLETE" }])).toBeUndefined();
    expect(lastRunObjectSet([])).toBeUndefined();
    expect(lastRunObjectSet(undefined)).toBeUndefined();
  });

  it("matches on kind, never on name", () => {
    // A set NAMED "LAST_RUN" whose kind is something else must not match: the
    // library reads `kind`, and a name is free text.
    expect(lastRunObjectSet([{ name: "LAST_RUN", kind: "COMPLETE" }])).toBeUndefined();
  });
});

describe("atcTimestampSeconds", () => {
  it("is `new Date(x).getTime() / 1000`, the library's own conversion", () => {
    const iso = "2026-08-18T09:30:00Z";
    expect(atcTimestampSeconds(iso)).toBe(new Date(iso).getTime() / 1000);
  });

  it("returns undefined for anything Date cannot parse, so no NaN reaches the wire", () => {
    expect(atcTimestampSeconds(undefined)).toBeUndefined();
    expect(atcTimestampSeconds("")).toBeUndefined();
    expect(atcTimestampSeconds("not a date")).toBeUndefined();
  });
});

describe("parseAtcLocation", () => {
  it("splits the ADT #start= fragment into line and column", () => {
    expect(
      parseAtcLocation("/sap/bc/adt/oo/classes/zcl_a/source/main#start=17,4;end=17,9"),
    ).toEqual({
      uri: "/sap/bc/adt/oo/classes/zcl_a/source/main",
      line: 17,
      column: 4,
    });
  });

  it("reads a start with a line only", () => {
    expect(parseAtcLocation("/x/source/main#start=42")).toEqual({
      uri: "/x/source/main",
      line: 42,
    });
  });

  it("returns the path alone when there is no fragment", () => {
    expect(parseAtcLocation("/x/source/main")).toEqual({ uri: "/x/source/main" });
  });

  it("returns no line rather than a wrong one when the fragment is unparseable", () => {
    // A wrong line number sends a reader to the wrong place; no line number
    // just sends them to the object.
    expect(parseAtcLocation("/x#start=abc")).toEqual({ uri: "/x" });
    expect(parseAtcLocation("/x#end=1,2")).toEqual({ uri: "/x" });
  });

  it("tolerates undefined", () => {
    expect(parseAtcLocation(undefined)).toEqual({ uri: "" });
  });
});

describe("priorityLabel", () => {
  it("names the three documented priorities", () => {
    expect(priorityLabel(1)).toBe("error");
    expect(priorityLabel(2)).toBe("warning");
    expect(priorityLabel(3)).toBe("info");
  });

  it("passes an unknown priority through visibly instead of guessing", () => {
    expect(priorityLabel(0)).toBe("prio 0");
    expect(priorityLabel(4)).toBe("prio 4");
  });
});
