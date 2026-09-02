/**
 * Headless-dynpro diagnostic — offline, no fake transport needed.
 * Exercises `isHeadlessDynproFailure` and `assertDdicTranscript` directly
 * against hand-built transcripts, the same shape `parseDdicTranscript`
 * produces from a real `ZMCP-DDIC-ERR>` line (see test/view-create.test.ts).
 */
import { describe, expect, it } from "vitest";
import { AbapError, isAbapError } from "../src/adt/errors.js";
import {
  DDIC_BRIDGE_CLASS,
  DDIC_ERR_PREFIX,
  DDIC_TAGS,
  assertDdicTranscript,
  isHeadlessDynproFailure,
  parseDdicTranscript,
  type DdicTranscript,
} from "../src/adt/ddic-bridge.js";

const REAL_LINE = "Sending of dynpro SAPLSTRD 0352 not possible: No window system type specified";

describe("isHeadlessDynproFailure", () => {
  it("is true for the real observed server line", () => {
    expect(isHeadlessDynproFailure(REAL_LINE)).toBe(true);
  });

  it("is true for a different dynpro/program in the same shape — not pinned to SAPLSTRD 0352", () => {
    expect(
      isHeadlessDynproFailure("Sending of dynpro SAPLSLVC_FULLSCREEN 0100 not possible: No window system type specified"),
    ).toBe(true);
  });

  it("is false for an ordinary bridge error line", () => {
    expect(isHeadlessDynproFailure("OBJECT_LOCKED_BY_OTHER_USER: view is locked by USER2")).toBe(false);
  });

  it("is false for undefined", () => {
    expect(isHeadlessDynproFailure(undefined)).toBe(false);
  });
});

describe("assertDdicTranscript — headless dynpro hint", () => {
  const catchIt = (result: DdicTranscript): AbapError => {
    try {
      assertDdicTranscript(result, [], "Creating classic view ZFOO");
      throw new Error("expected assertDdicTranscript to throw");
    } catch (e) {
      if (!isAbapError(e)) throw e;
      return e;
    }
  };

  it("attaches the dynpro hint, keeps code CHECK_FAILED and the message byte-identical", () => {
    const raw = `${DDIC_ERR_PREFIX} ${REAL_LINE}`;
    const transcript = parseDdicTranscript(raw);
    const err = catchIt(transcript);

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toBe(`Creating classic view ZFOO failed on the server: ${REAL_LINE}`);
    expect(err.hint).toBeDefined();
    expect(err.hint).toMatch(/transport/i);
    expect(err.hint).not.toMatch(/\$TMP/);
    expect(err.hint).toMatch(/corr_nr/);
  });

  it("attaches no dynpro hint for an ordinary error line", () => {
    const raw = `${DDIC_ERR_PREFIX} OBJECT_LOCKED_BY_OTHER_USER: view is locked by USER2`;
    const transcript = parseDdicTranscript(raw);
    const err = catchIt(transcript);

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toBe(
      "Creating classic view ZFOO failed on the server: OBJECT_LOCKED_BY_OTHER_USER: view is locked by USER2",
    );
    expect(err.hint).toBeUndefined();
  });
});

describe("assertDdicTranscript — partial success (completed tags)", () => {
  const catchIt = (
    result: DdicTranscript,
    opts?: Parameters<typeof assertDdicTranscript>[3],
  ): AbapError => {
    try {
      assertDdicTranscript(result, [], "Creating package ZTM_TESTPKG", opts);
      throw new Error("expected assertDdicTranscript to throw");
    } catch (e) {
      if (!isAbapError(e)) throw e;
      return e;
    }
  };

  it("a fired tag with a `completed` entry adds the partial-success sentence, details, and hint prefix", () => {
    const raw = "PKG-CREATED\n" + `${DDIC_ERR_PREFIX} Attaching super package failed, sy-subrc=1, 465`;
    const transcript = parseDdicTranscript(raw);
    const err = catchIt(transcript, {
      completed: { "PKG-CREATED": "package ZTM_TESTPKG was created and saved" },
      partialHint: "abap_transport operation=list shows the requests owned by this user.",
    });

    expect(err.code).toBe("CHECK_FAILED");
    expect(err.message).toBe(
      "Creating package ZTM_TESTPKG failed on the server: Attaching super package failed, sy-subrc=1, 465. " +
        "PARTIAL SUCCESS, NOT A NO-OP: this is a multi-step operation and earlier steps already took " +
        "effect on the server and were NOT rolled back — package ZTM_TESTPKG was created and saved.",
    );
    expect(err.details.partial).toBe(true);
    expect(err.details.completed).toEqual(["PKG-CREATED"]);
    expect(err.details.raw).toBe(raw);
    expect(err.hint).toBe(
      "Do NOT simply retry this call: what is named above already exists, so a retry will collide " +
        "with an object the caller did not know it had created. Establish the object's current state " +
        "first and either continue from there or remove it, then create it again. " +
        "abap_transport operation=list shows the requests owned by this user.",
    );
  });

  it("names fired completed tags in transcript order, joined with '; '", () => {
    const raw = "PKG-CREATED\nPKG-PARENT-SET\n" + `${DDIC_ERR_PREFIX} TDEVC has no row for ZTM_TESTPKG after create`;
    const transcript = parseDdicTranscript(raw);
    const err = catchIt(transcript, {
      completed: {
        "PKG-CREATED": "the package was created",
        "PKG-PARENT-SET": "the super package was attached",
      },
    });
    expect(err.message).toContain("the package was created; the super package was attached.");
    expect(err.details.completed).toEqual(["PKG-CREATED", "PKG-PARENT-SET"]);
  });

  it("a tag that did NOT fire contributes nothing, even if it has a `completed` entry", () => {
    const raw = `${DDIC_ERR_PREFIX} Creating package failed, sy-subrc=1, 465`;
    const transcript = parseDdicTranscript(raw);
    const err = catchIt(transcript, { completed: { "PKG-CREATED": "the package was created" } });
    expect(err.message).not.toMatch(/PARTIAL SUCCESS/);
    expect(err.details.partial).toBeUndefined();
    expect(err.details.completed).toBeUndefined();
  });

  it("byte-identical to no-opts behaviour when the fired-tag list has no `completed` entries", () => {
    const raw = `${DDIC_ERR_PREFIX} Attaching super package failed, sy-subrc=1, 465`;
    const withoutOpts = catchIt(parseDdicTranscript("PKG-CREATED\n" + raw));
    const withOpts = catchIt(parseDdicTranscript("PKG-CREATED\n" + raw), {
      completed: { "VIEW-PUT": "unrelated tag, never fires here" },
    });
    expect(withOpts.message).toBe(withoutOpts.message);
    expect(withOpts.details).toEqual(withoutOpts.details);
    expect(withOpts.hint).toBe(withoutOpts.hint);
    expect(withoutOpts.message).toBe(
      "Creating package ZTM_TESTPKG failed on the server: Attaching super package failed, sy-subrc=1, 465",
    );
    expect(withoutOpts.details).toEqual({ raw: "PKG-CREATED\n" + raw });
    expect(withoutOpts.hint).toBeUndefined();
  });

  it("errorLine with no trailing punctuation gets '. ' before PARTIAL SUCCESS, not a bare space", () => {
    const raw = "PKG-CREATED\n" + `${DDIC_ERR_PREFIX} Attaching super package failed, sy-subrc=1, 465`;
    const err = catchIt(parseDdicTranscript(raw), {
      completed: { "PKG-CREATED": "package ZTM_TESTPKG was created and saved" },
    });
    expect(err.message).toContain("sy-subrc=1, 465. PARTIAL SUCCESS, NOT A NO-OP:");
  });

  it("errorLine already ending in '.' gets exactly one period plus one space, never '.. '", () => {
    const raw = "PKG-CREATED\n" + `${DDIC_ERR_PREFIX} Attaching super package failed.`;
    const err = catchIt(parseDdicTranscript(raw), {
      completed: { "PKG-CREATED": "package ZTM_TESTPKG was created and saved" },
    });
    expect(err.message).toContain("Attaching super package failed. PARTIAL SUCCESS, NOT A NO-OP:");
    expect(err.message).not.toMatch(/\.\.\s*PARTIAL SUCCESS/);
  });

  it("existing callers that pass no fourth argument at all (package-delete/view-delete/tran-delete/view-create/tran-create) are unaffected", () => {
    const raw = `${DDIC_ERR_PREFIX} Deleting package failed, sy-subrc=1, 123`;
    const transcript = parseDdicTranscript("PKG-EMPTY\n" + raw);
    const err = catchIt(transcript); // no fourth argument, exactly like every non-package-create bridge
    expect(err.message).toBe("Creating package ZTM_TESTPKG failed on the server: Deleting package failed, sy-subrc=1, 123");
    expect(err.details).toEqual({ raw: "PKG-EMPTY\n" + raw });
    expect(err.hint).toBeUndefined();
  });
});

describe("registration", () => {
  it("DDIC_TAGS carries the four new view/transaction-delete tags", () => {
    expect(DDIC_TAGS).toEqual(
      expect.arrayContaining(["VIEW-DELETED", "VIEW-GONE", "TRAN-DELETED", "TRAN-GONE"]),
    );
  });

  it("DDIC_BRIDGE_CLASS carries the two new delete bridge class names", () => {
    expect(DDIC_BRIDGE_CLASS.deleteView).toBe("ZCL_ZMCP_DDIC_DVIEW");
    expect(DDIC_BRIDGE_CLASS.deleteTransaction).toBe("ZCL_ZMCP_DDIC_DTRAN");
  });
});
