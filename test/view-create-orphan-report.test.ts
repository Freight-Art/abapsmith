/**
 * `viewCreatePartialSuccess` — honest partial-failure reporting for a
 * transportable classic-view create. Since `RS_CORR_INSERT` now runs before
 * `DDIF_VIEW_PUT` (see test/view-create-corr-key.test.ts), a failure after
 * an earlier step must name exactly what is already on the server and how to
 * clear it, rather than reporting only the overall failure.
 *
 * On the base version (before this fix) `viewCreatePartialSuccess` does not
 * exist at all — importing it is the red proof for this file, separate from
 * the behavioural red `view-create-corr-key.test.ts` gives against the same
 * base.
 */
import { describe, expect, it } from "vitest";
import {
  DDIC_ERR_PREFIX,
  DDIC_TAGS,
  assertDdicTranscript,
  parseDdicTranscript,
  type DdicTag,
} from "../src/adt/ddic-bridge.js";
import { viewCreatePartialSuccess } from "../src/adt/view-create.js";
import { AbapError, isAbapError } from "../src/adt/errors.js";

const VIEW_NAME = "ZTM_V_CARRIER";

const catchSync = (fn: () => unknown): AbapError => {
  try {
    fn();
  } catch (e) {
    if (isAbapError(e)) return e;
    throw e;
  }
  throw new Error("expected an AbapError to be thrown");
};

describe("viewCreatePartialSuccess", () => {
  const partial = viewCreatePartialSuccess(VIEW_NAME);

  it("declares completed only for tags the fragment actually emits", () => {
    for (const tag of Object.keys(partial.completed)) {
      expect(DDIC_TAGS).toContain(tag as DdicTag);
    }
    expect(Object.keys(partial.completed).sort()).toEqual(["VIEW-PUT", "VIEW-REGISTERED"].sort());
  });

  it("VIEW-REGISTERED-only transcript: CHECK_FAILED names registration as already done, hint carries the recovery step, and does NOT claim a view exists", () => {
    const transcript = parseDdicTranscript(
      `VIEW-REGISTERED\n${DDIC_ERR_PREFIX} DDIF_VIEW_PUT failed, sy-subrc=4, DT123`,
    );
    const err = catchSync(() =>
      assertDdicTranscript(transcript, ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"], "Creating classic view", {
        completed: partial.completed,
        partialHint: partial.hint,
      }),
    );
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("PARTIAL SUCCESS");
    expect(err.message).toContain("registered");
    expect(err.message).toContain(VIEW_NAME);
    expect(err.message).toContain("TADIR");
    // No dictionary write happened yet — the message must not claim the view exists.
    expect(err.message).not.toMatch(/DDIF_VIEW_PUT wrote/);
    expect(err.hint).toContain("SE09/SE10");
  });

  it("VIEW-REGISTERED + VIEW-PUT transcript: CHECK_FAILED names BOTH steps as already done, hint says the view can be deleted", () => {
    const transcript = parseDdicTranscript(
      `VIEW-REGISTERED\nVIEW-PUT\n${DDIC_ERR_PREFIX} DDIF_VIEW_ACTIVATE failed, sy-subrc=1, RS123`,
    );
    const err = catchSync(() =>
      assertDdicTranscript(transcript, ["VIEW-REGISTERED", "VIEW-PUT", "VIEW-ACTIVATED"], "Creating classic view", {
        completed: partial.completed,
        partialHint: partial.hint,
      }),
    );
    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toContain("PARTIAL SUCCESS");
    expect(err.message).toContain("registered");
    expect(err.message).toContain("DDIF_VIEW_PUT wrote");
    expect(err.message).toContain(VIEW_NAME);
    expect(err.hint).toContain('mode="delete"');
    expect(err.hint).toContain("VIEW/DV");
  });
});
