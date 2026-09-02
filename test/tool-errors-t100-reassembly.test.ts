/**
 * T100 message-variable reassembly — regression coverage for a live decoded
 * failure, not a hypothetical one.
 *
 * A live agent hit this raw ADT error twice while deactivating a BAdI
 * implementation:
 *
 *   message: Parameter Enhancement ZTM_ENH_HW011_IMPL must still be adjus
 *            not in version ted of tp configuration
 *
 * SAP's T100 mechanism carries free text in MSGV1..MSGV4 (`T100KEY-V1..V4`),
 * each a fixed 50-character-wide field. The real underlying sentence,
 * "Enhancement ZTM_ENH_HW011_IMPL must still be adjusted" (53 characters),
 * was chopped at exactly the 50th character with no separator:
 *
 *   v1 = "Enhancement ZTM_ENH_HW011_IMPL must still be adjus"  (50 chars)
 *   v2 = "ted"                                                 (3 chars)
 *
 * ...and both fragments were then substituted into an UNRELATED template,
 * "Parameter &1 not in version &2 of tp configuration" — which is why the
 * raw message reads as nonsense. Verified by hand before writing this suite:
 * `"Enhancement ZTM_ENH_HW011_IMPL must still be adjus".length === 50` and
 * `"Enhancement ZTM_ENH_HW011_IMPL must still be adjus" + "ted" ===
 * "Enhancement ZTM_ENH_HW011_IMPL must still be adjusted"`.
 *
 * `reassembleSplitT100Variables` (src/tool-errors.ts) undoes this, wired
 * into `envelopeFromProperties` — the single choke point every ADT error
 * path (`adtEnvelopeFromThrown`, and both `properties`/`t100` branches of
 * `adtEnvelopeFromDetails`) funnels through. These tests go through
 * `buildErrorPayload`/`errorResult` from `../src/tool-errors.js` directly,
 * exercising the raw-throw path the live failure actually took.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildErrorPayload, errorResult } from "../src/tool-errors.js";
import { AbapError } from "../src/adt/errors.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function envelope(res: CallToolResult): Record<string, any> {
  const text = (res.content[0] as { type: "text"; text: string }).text;
  return JSON.parse(text);
}

// The exact 50-character fragment from the live capture.
const V1_LIVE = "Enhancement ZTM_ENH_HW011_IMPL must still be adjus";
const V2_LIVE = "ted";
const RECONSTRUCTED_LIVE = "Enhancement ZTM_ENH_HW011_IMPL must still be adjusted";

describe("T100 variable reassembly — live decoded failure", () => {
  it("hand-verified arithmetic: v1 is exactly 50 chars, v1+v2 reproduces the original sentence", () => {
    expect(V1_LIVE.length).toBe(50);
    expect(V1_LIVE + V2_LIVE).toBe(RECONSTRUCTED_LIVE);
  });

  it("decodes the exact live string: v1 (50 chars) + v2 (3 chars) reassembles to the real sentence", () => {
    const e = Object.assign(new Error("Parameter Enhancement ZTM_ENH_HW011_IMPL must still be adjus not in version ted of tp configuration"), {
      err: 400,
      type: "ExceptionResourceAlreadyExists",
      properties: {
        "T100KEY-ID": "TB",
        "T100KEY-NO": "123",
        "T100KEY-V1": V1_LIVE,
        "T100KEY-V2": V2_LIVE,
      },
    });
    const body = envelope(errorResult(e));
    expect(body.error).toBe("ADT_ERROR");
    expect(body.adt.status).toBe(400);
    expect(body.adt.exceptionType).toBe("ExceptionResourceAlreadyExists");
    // Raw fragments survive untouched, alongside the reconstruction.
    expect(body.adt.t100.variables.v1).toBe(V1_LIVE);
    expect(body.adt.t100.variables.v2).toBe(V2_LIVE);
    // The reconstruction is a clearly-labelled EXTRA field, not a replacement.
    expect(body.adt.t100.reassembled).toEqual([{ from: ["v1", "v2"], value: RECONSTRUCTED_LIVE }]);
    // The original (garbled) message text is never discarded.
    expect(body.message).toContain("not in version ted of tp configuration");
  });

  it("a 49-character parameter is NEVER joined to its successor (false-positive guard)", () => {
    const v1_49 = "x".repeat(49);
    const e = Object.assign(new Error("Parameter x not in version y of tp configuration"), {
      err: 400,
      properties: {
        "T100KEY-V1": v1_49,
        "T100KEY-V2": "SOMETHING_UNRELATED",
      },
    });
    const body = envelope(errorResult(e));
    expect(body.adt.t100.variables.v1).toBe(v1_49);
    expect(body.adt.t100.variables.v2).toBe("SOMETHING_UNRELATED");
    // No reassembly reported at all — a 49-char value is provably not chopped.
    expect(body.adt.t100.reassembled).toBeUndefined();
  });

  it("chains across three consecutive 50-character parameters", () => {
    const v1 = "a".repeat(50);
    const v2 = "b".repeat(50);
    const v3 = "c".repeat(50);
    const e = Object.assign(new Error("irrelevant template text"), {
      err: 400,
      properties: {
        "T100KEY-V1": v1,
        "T100KEY-V2": v2,
        "T100KEY-V3": v3,
      },
    });
    const body = envelope(errorResult(e));
    expect(body.adt.t100.reassembled).toEqual([{ from: ["v1", "v2", "v3"], value: v1 + v2 + v3 }]);
  });

  it("a message with no 50-character parameter passes through completely untouched", () => {
    const e = Object.assign(new Error("Parameter DEVELOPER not in version ZMCP_DBG_DEMO of tp configuration"), {
      err: 400,
      properties: {
        "T100KEY-ID": "EU",
        "T100KEY-NO": "510",
        "T100KEY-V1": "DEVELOPER",
        "T100KEY-V2": "ZMCP_DBG_DEMO",
      },
    });
    const body = envelope(errorResult(e));
    expect(body.adt.t100.variables.v1).toBe("DEVELOPER");
    expect(body.adt.t100.variables.v2).toBe("ZMCP_DBG_DEMO");
    expect(body.adt.t100.reassembled).toBeUndefined();
    expect(body.message).toBe("Parameter DEVELOPER not in version ZMCP_DBG_DEMO of tp configuration");
  });

  it("a lone 50-character variable with no successor is not reported as a split", () => {
    const v1 = "z".repeat(50);
    const e = Object.assign(new Error("template text"), {
      err: 400,
      properties: { "T100KEY-V1": v1 },
    });
    const body = envelope(errorResult(e));
    expect(body.adt.t100.variables.v1).toBe(v1);
    expect(body.adt.t100.reassembled).toBeUndefined();
  });

  it("original message survives on the AbapError.details.t100 path too", () => {
    const e = new AbapError(
      "ADT_ERROR",
      "Parameter Enhancement ZTM_ENH_HW011_IMPL must still be adjus not in version ted of tp configuration",
      {
        operation: "write",
        status: 400,
        adtExceptionType: "ExceptionResourceAlreadyExists",
        t100: { "T100KEY-ID": "TB", "T100KEY-NO": "123", "T100KEY-V1": V1_LIVE, "T100KEY-V2": V2_LIVE },
      },
    );
    const body = envelope(errorResult(e));
    expect(body.message).toBe(
      "Parameter Enhancement ZTM_ENH_HW011_IMPL must still be adjus not in version ted of tp configuration",
    );
    expect(body.adt.t100.reassembled).toEqual([{ from: ["v1", "v2"], value: RECONSTRUCTED_LIVE }]);
    expect(body.adt.t100.variables.v1).toBe(V1_LIVE);
  });

  it("original message survives on the AbapError.details.properties path too", () => {
    const e = new AbapError(
      "ADT_ERROR",
      "some prose message",
      {
        operation: "write",
        properties: { "T100KEY-ID": "TB", "T100KEY-NO": "123", "T100KEY-V1": V1_LIVE, "T100KEY-V2": V2_LIVE },
      },
    );
    const body = envelope(errorResult(e));
    expect(body.message).toBe("some prose message");
    expect(body.adt.t100.reassembled).toEqual([{ from: ["v1", "v2"], value: RECONSTRUCTED_LIVE }]);
  });
});

/**
 * Gap 2: `reassembleSplitT100Variables` above can only reassemble what
 * `envelopeFromProperties` gives it — and when SAP's `<properties/>` block
 * is completely EMPTY (no `T100KEY-ID`/`NO`/`V1..V4` entries at all),
 * `envelopeFromProperties` never sets `env.t100` in the first place. That is
 * exactly what happened live: the same chopped-and-mistemplated sentence as
 * the suite above, but the raw ADT error this time carried no `properties` at
 * all — `err: 400`, `type: "ExceptionResourceAlreadyExists"`, nothing else
 * — so there was never a T100KEY bag for the reassembly function to work
 * from, and `adt.t100` was entirely absent from the response.
 *
 * `matchXt465ChoppedTemplate`/`withXt465Fallback` (`src/tool-errors.ts`)
 * close this ONE specific instance: SAP message class XT465's fixed literal
 * template (`"Parameter &1 not in version &2 of tp configuration"`) lets
 * the chopped variables be recovered from the rendered TEXT alone, when
 * (and only when) no real T100 data survived to do the job properly. The
 * negative-case tests below are the load-bearing ones: fixture 543
 * (`543-xt465-tp-config-delete-400.xml`) is a REAL, LEGITIMATE XT465
 * message ("Parameter LSM not in version 0001 of tp configuration") and
 * must survive completely untouched — never concatenated into a fabricated
 * "LSM0001" — even in the worst case where its properties bag was ALSO
 * empty.
 */
describe("T100 variable reassembly — XT465 template fallback for an empty <properties/> block", () => {
  const FIXTURE_543 = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "enhancement", "543-xt465-tp-config-delete-400.xml"),
    "utf8",
  );
  // Pulled out of the real fixture bytes, not hand-typed, so this constant
  // cannot silently drift from what SAP actually sent.
  const LEGIT_XT465_MESSAGE = (() => {
    const m = /<message lang="EN">([^<]*)<\/message>/.exec(FIXTURE_543);
    if (!m) throw new Error("fixture 543 message text not found — fixture changed shape");
    return m[1] as string;
  })();

  it("sanity: fixture 543's message is the real, legitimate XT465 sentence, not the chopped one", () => {
    expect(LEGIT_XT465_MESSAGE).toBe("Parameter LSM not in version 0001 of tp configuration");
  });

  it("recovers the live chop (raw-throw path) even though the properties bag was completely empty", () => {
    const liveMessage =
      "Parameter Enhancement ZTM_ENH_HW011_IMPL must still be adjus not in version ted of tp configuration";
    // No `properties` key at all — the exact live shape: `adtExceptionInfo`
    // normalises a missing `.properties` to `{}`, never `undefined`.
    const e = Object.assign(new Error(liveMessage), {
      err: 400,
      type: "ExceptionResourceAlreadyExists",
    });
    const body = envelope(errorResult(e));
    expect(body.adt.status).toBe(400);
    expect(body.adt.exceptionType).toBe("ExceptionResourceAlreadyExists");
    expect(body.adt.t100).toBeDefined();
    expect(body.adt.t100.id).toBe("XT");
    expect(body.adt.t100.no).toBe("465");
    expect(body.adt.t100.reassembled).toEqual([
      { from: ["v1", "v2"], value: RECONSTRUCTED_LIVE },
    ]);
    // The original (garbled) message text is never rewritten.
    expect(body.message).toBe(liveMessage);
  });

  it("recovers the live chop on the AbapError.details path too, with no t100/properties on details at all", () => {
    const liveMessage =
      "Parameter Enhancement ZTM_ENH_HW011_IMPL must still be adjus not in version ted of tp configuration";
    const e = new AbapError("ADT_ERROR", liveMessage, {
      operation: "write",
      status: 400,
      adtExceptionType: "ExceptionResourceAlreadyExists",
    });
    const body = envelope(errorResult(e));
    expect(body.adt.t100.id).toBe("XT");
    expect(body.adt.t100.no).toBe("465");
    expect(body.adt.t100.reassembled).toEqual([
      { from: ["v1", "v2"], value: RECONSTRUCTED_LIVE },
    ]);
  });

  it("NEVER corrupts fixture 543's real message, even in the worst case of an empty properties bag (raw-throw path)", () => {
    const e = Object.assign(new Error(LEGIT_XT465_MESSAGE), {
      err: 400,
      type: "ExceptionResourceDeletionFailure",
    });
    const body = envelope(errorResult(e));
    // No t100 at all: group 1 ("LSM") is 3 characters, not 50 — provably not
    // a chop candidate — so the fallback declines and nothing is fabricated.
    expect(body.adt.t100).toBeUndefined();
    expect(body.message).toBe(LEGIT_XT465_MESSAGE);
    expect(body.message).not.toContain("LSM0001");
  });

  it("NEVER corrupts fixture 543's real message on the AbapError.details path either", () => {
    const e = new AbapError("ADT_ERROR", LEGIT_XT465_MESSAGE, {
      operation: "delete",
      status: 400,
      adtExceptionType: "ExceptionResourceDeletionFailure",
    });
    const body = envelope(errorResult(e));
    expect(body.adt.t100).toBeUndefined();
    expect(body.message).toBe(LEGIT_XT465_MESSAGE);
  });

  it("fixture 543's ACTUAL properties (T100KEY-V1=LSM, V2=0001 present) already short-circuit the fallback — real data always wins", () => {
    // Ground truth: fixture 543 in fact DOES carry T100KEY-* data (not an
    // empty bag) — this is the ordinary, already-working case
    // (reassembleSplitT100Variables correctly declines a 3-char v1). Proves
    // the new fallback is never even consulted when real properties exist.
    const e = Object.assign(new Error(LEGIT_XT465_MESSAGE), {
      err: 400,
      type: "ExceptionResourceDeletionFailure",
      properties: {
        MSGID: "XT",
        MSGNO: "465",
        "T100KEY-ID": "XT",
        "T100KEY-NO": "465",
        "T100KEY-V1": "LSM",
        "T100KEY-V2": "0001",
      },
    });
    const body = envelope(errorResult(e));
    expect(body.adt.t100.variables.v1).toBe("LSM");
    expect(body.adt.t100.variables.v2).toBe("0001");
    expect(body.adt.t100.reassembled).toBeUndefined();
    expect(body.message).toBe(LEGIT_XT465_MESSAGE);
  });
});
