/**
 * `parsePreviewBody`'s `totalRows` field.
 *
 * `<dataPreview:totalRows>` reports the TRUE total match count for the
 * statement that produced the body, independent of whatever row cap the
 * caller passed as `rowNumber` — this is what `img-read.ts` uses to know a
 * tree node's real child count without a dedicated COUNT(*) builder.
 *
 * Two of the three cases below are driven by real captured bytes (the `ddic`
 * cassette, which pins the documented "always reports 0" quirk, and a
 * live-captured `freestyle` response carrying a genuine non-zero total). The
 * third — the element missing from the wire entirely — has no existing
 * capture (every DDIC/freestyle response this repo has captured so far
 * happens to include the element), so it is a hand-built minimal document,
 * clearly marked as such rather than passed off as a capture.
 */
import { describe, expect, it } from "vitest";

import { parsePreviewBody } from "../src/adt/datapreview.js";
import { loadAllCassettes } from "./cassettes/registry.js";
import type { Cassette } from "./cassettes/schema.js";

const CASSETTES = new Map<string, Cassette>(loadAllCassettes().map((c) => [c.id, c]));

function capturedBody(id: string): string {
  const found = CASSETTES.get(id);
  if (!found) {
    throw new Error(`cassette '${id}' not found under test/cassettes/ — known ids: ${[...CASSETTES.keys()].join(", ")}`);
  }
  if (found.response.body === null) throw new Error(`cassette '${id}' has no response body`);
  return found.response.body;
}

/** The `dataPreview:` namespace root every real response body uses. */
const NS = 'xmlns:dataPreview="http://www.sap.com/adt/dataPreview"';

describe("parsePreviewBody — totalRows", () => {
  it("parses a genuinely non-zero total from a live-captured freestyle body (087-p3b-datapreview-t000)", () => {
    // Real bytes captured from a `SELECT MANDT, CCCATEGORY, CCCORACTIV FROM
    // T000 ... UP TO 20 ROWS` freestyle call that matched exactly 2 rows.
    const body =
      '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData ' +
      NS +
      "><dataPreview:totalRows>2</dataPreview:totalRows>" +
      "<dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView>" +
      "<dataPreview:columns>" +
      '<dataPreview:metadata dataPreview:name="MANDT" dataPreview:type="C" dataPreview:keyAttribute="false"/>' +
      "<dataPreview:dataSet><dataPreview:data>000</dataPreview:data><dataPreview:data>001</dataPreview:data></dataPreview:dataSet>" +
      "</dataPreview:columns></dataPreview:tableData>";
    const parsed = parsePreviewBody(body);
    expect(parsed.totalRows).toBe(2);
    expect(parsed.rows).toHaveLength(2);
  });

  it("PINS the ddic endpoint's documented always-0 quirk as a genuine 0, not undefined (ddic-t000-rows3, 2 real rows)", () => {
    // This is the case the spec calls out explicitly: the ddic endpoint
    // reports totalRows=0 even though this exact capture carries 2 real
    // rows. A `0` here must reach the caller as `0`, never coerced away.
    const parsed = parsePreviewBody(capturedBody("ddic-t000-rows3"));
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.totalRows).toBe(0);
    expect(parsed.totalRows).not.toBeUndefined();
  });

  it("is undefined when <dataPreview:totalRows> is absent from the wire entirely", () => {
    // Hand-built: every capture on disk happens to include the element, so
    // this exercises the "genuinely missing" branch that none of them can.
    const body =
      '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData ' +
      NS +
      "><dataPreview:columns>" +
      '<dataPreview:metadata dataPreview:name="MANDT" dataPreview:type="C" dataPreview:keyAttribute="false"/>' +
      "<dataPreview:dataSet><dataPreview:data>000</dataPreview:data></dataPreview:dataSet>" +
      "</dataPreview:columns></dataPreview:tableData>";
    const parsed = parsePreviewBody(body);
    expect(parsed.totalRows).toBeUndefined();
  });

  it("is undefined, not NaN or 0, when <dataPreview:totalRows> is present but empty", () => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData ' +
      NS +
      "><dataPreview:totalRows></dataPreview:totalRows>" +
      "<dataPreview:columns/></dataPreview:tableData>";
    const parsed = parsePreviewBody(body);
    expect(parsed.totalRows).toBeUndefined();
  });

  it("is undefined, not NaN, when <dataPreview:totalRows> holds non-numeric text", () => {
    const body =
      '<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData ' +
      NS +
      "><dataPreview:totalRows>not-a-number</dataPreview:totalRows>" +
      "<dataPreview:columns/></dataPreview:tableData>";
    const parsed = parsePreviewBody(body);
    expect(parsed.totalRows).toBeUndefined();
  });

  it("does not disturb columns/rows/messages on a body that also carries totalRows (additive-only guard)", () => {
    const parsed = parsePreviewBody(capturedBody("ddic-svers-single-column-single-row"));
    expect(parsed.columns).toHaveLength(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.messages).toEqual([]);
    expect(parsed.totalRows).toBe(0);
  });
});
