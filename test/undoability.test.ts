/**
 * Issue #200: unit tests for the pure undoability policy (src/undoability.ts)
 * — `writeTimeUndoability`'s 12 ordered rules and `precedingWriteEntry`'s
 * preceding-write lookup. Pure functions, no I/O: entries are hand-built
 * fixtures, never read from a real Journal.
 */
import { describe, expect, it } from "vitest";
import {
  IRREVERSIBLE_UNDO_BLOCKER,
  SERVICE_PUBLISH_UNDO_BLOCKER,
  SERVICE_UNPUBLISH_UNDO_BLOCKER,
  TRANSPORT_GENERIC_UNDO_BLOCKER,
  TRANSPORT_RELEASE_UNDO_BLOCKER,
  captureExplanation,
  deleteEvidenceBlockerText,
  packageRecreateBlockerText,
  precedingWriteEntry,
  writeTimeUndoability,
} from "../src/undoability.js";
import type { JournalEntry, JournalOperation } from "../src/journal.js";

let nextId = 1;

/** A plain, otherwise-undoable `update` entry (rule 12's happy path), overridable per test. */
function entry(overrides: Partial<JournalEntry> & { object?: Partial<JournalEntry["object"]> } = {}): JournalEntry {
  const { object, ...rest } = overrides;
  return {
    id: `e${nextId++}`,
    ts: "2024-01-01T00:00:00.000Z",
    system: "A4H",
    operation: "update",
    object: {
      name: "ZTEST",
      type: "PROG/P",
      uri: "/sap/bc/adt/programs/programs/ztest",
      package: "$TMP",
      ...object,
    },
    existedBefore: true,
    beforeCapture: "captured",
    before: { etag: "e", fingerprint: "f", bytes: 10, blob: "blob1" },
    outcome: "succeeded",
    ...rest,
  } as JournalEntry;
}

describe("writeTimeUndoability", () => {
  describe("rule 1: caller-supplied blocker always wins", () => {
    it("overrides what would otherwise be an ordinary undoable restore (rule 12)", () => {
      const e = entry();
      const r = writeTimeUndoability(e, { callerBlocker: "custom narrowing reason" });
      expect(r).toEqual({ undoable: false, undoBlocker: "custom narrowing reason" });
    });

    it("wins even over an activate entry with a perfectly undoable preceding write", () => {
      const pw = entry();
      const activateEntry = entry({ operation: "activate" });
      const r = writeTimeUndoability(activateEntry, {
        callerBlocker: "narrowed",
        precedingWrite: pw,
      });
      expect(r).toEqual({ undoable: false, undoBlocker: "narrowed" });
    });
  });

  describe("rule 2: transport/service operations", () => {
    it("transport-release", () => {
      const r = writeTimeUndoability(entry({ operation: "transport-release" }), {});
      expect(r).toEqual({ undoable: false, undoBlocker: TRANSPORT_RELEASE_UNDO_BLOCKER });
    });

    it("service-publish", () => {
      const r = writeTimeUndoability(entry({ operation: "service-publish" }), {});
      expect(r).toEqual({ undoable: false, undoBlocker: SERVICE_PUBLISH_UNDO_BLOCKER });
    });

    it("service-unpublish", () => {
      const r = writeTimeUndoability(entry({ operation: "service-unpublish" }), {});
      expect(r).toEqual({ undoable: false, undoBlocker: SERVICE_UNPUBLISH_UNDO_BLOCKER });
    });

    it.each([
      "transport-create",
      "transport-add-user",
      "transport-set-owner",
      "transport-delete",
      "transport-remove-object",
    ] as JournalOperation[])("%s falls back to the generic transport blocker", (op) => {
      const r = writeTimeUndoability(entry({ operation: op }), {});
      expect(r).toEqual({ undoable: false, undoBlocker: TRANSPORT_GENERIC_UNDO_BLOCKER });
    });
  });

  describe("rule 3: activate delegates to the preceding write", () => {
    it("no preceding write at all -> not undoable, names the object", () => {
      const activateEntry = entry({
        operation: "activate",
        object: { name: "ZFOO", type: "CLAS/OC" },
      });
      const r = writeTimeUndoability(activateEntry, {});
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain("No earlier write entry for CLAS/OC ZFOO");
    });

    it("preceding write already undone -> not undoable, names the undoing entry", () => {
      const pw = entry({ id: "pw1", undoneBy: "undo-42" });
      const activateEntry = entry({ operation: "activate" });
      const r = writeTimeUndoability(activateEntry, { precedingWrite: pw });
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain("write entry pw1");
      expect(r.undoBlocker).toContain("already undone by undo-42");
    });

    it("preceding write explicitly marked not undoable (undoable === false) -> delegates its stored blocker", () => {
      const pw = entry({ id: "pw2", undoable: false, undoBlocker: "stored reason" });
      const activateEntry = entry({ operation: "activate" });
      const r = writeTimeUndoability(activateEntry, { precedingWrite: pw });
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain("write entry pw2");
      expect(r.undoBlocker).toContain("is not undoable: stored reason");
    });

    it("preceding write marked not undoable with no stored blocker text -> delegates an empty reason gracefully", () => {
      const pw = entry({ id: "pw3", undoable: false });
      const activateEntry = entry({ operation: "activate" });
      const r = writeTimeUndoability(activateEntry, { precedingWrite: pw });
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toBe("Undoing this activation means undoing write entry pw3, which is not undoable: ");
    });

    it("preceding write with undoable left unset -> recomputed on the fly, and found undoable", () => {
      const pw = entry({ id: "pw4" }); // undoable left unset; recursion hits rule 12 -> true
      const activateEntry = entry({ operation: "activate" });
      const r = writeTimeUndoability(activateEntry, { precedingWrite: pw });
      expect(r).toEqual({ undoable: true, undoBlocker: "" });
    });

    it("preceding write with undoable left unset -> recomputed, and found NOT undoable (e.g. an enhancement create with unknown capture)", () => {
      const pw = entry({
        id: "pw5",
        operation: "create",
        existedBefore: false,
        beforeCapture: "unknown",
        object: { name: "ZENHO", type: "ENHO/XH" },
      });
      const activateEntry = entry({ operation: "activate" });
      const r = writeTimeUndoability(activateEntry, { precedingWrite: pw });
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain("write entry pw5");
      expect(r.undoBlocker).toContain("is not undoable: " + deleteEvidenceBlockerText("ZENHO", "unknown"));
    });
  });

  describe("rule 4: irreversible catch-all, checked before any type-specific rule", () => {
    it("an ordinary entry marked irreversible is never undoable", () => {
      const r = writeTimeUndoability(entry({ irreversible: true }), {});
      expect(r).toEqual({ undoable: false, undoBlocker: IRREVERSIBLE_UNDO_BLOCKER });
    });

    it("irreversible wins even over the enhancement-specific rule (5)", () => {
      const r = writeTimeUndoability(
        entry({
          irreversible: true,
          operation: "create",
          existedBefore: false,
          beforeCapture: "confirmed-absent",
          object: { name: "ZENHO", type: "ENHO/XH" },
        }),
        {},
      );
      expect(r).toEqual({ undoable: false, undoBlocker: IRREVERSIBLE_UNDO_BLOCKER });
    });
  });

  describe("rule 5: enhancement objects (ENHO/XH, ENHO/XHH, ENHS/XS)", () => {
    it("create + confirmed-absent -> undoable (undo deletes it)", () => {
      const r = writeTimeUndoability(
        entry({
          operation: "create",
          existedBefore: false,
          beforeCapture: "confirmed-absent",
          object: { name: "ZSPOT", type: "ENHO/XH" },
        }),
        {},
      );
      expect(r).toEqual({ undoable: true, undoBlocker: "" });
    });

    it("create + unknown capture -> not undoable, delete-evidence blocker", () => {
      const r = writeTimeUndoability(
        entry({
          operation: "create",
          existedBefore: false,
          beforeCapture: "unknown",
          object: { name: "ZSPOT", type: "ENHO/XHH" },
        }),
        {},
      );
      expect(r).toEqual({ undoable: false, undoBlocker: deleteEvidenceBlockerText("ZSPOT", "unknown") });
    });

    it("create + existedBefore true -> not undoable, delete-evidence blocker (the confirmed-absent branch requires !existedBefore)", () => {
      const r = writeTimeUndoability(
        entry({
          operation: "create",
          existedBefore: true,
          beforeCapture: "confirmed-absent",
          object: { name: "ZSPOT", type: "ENHS/XS" },
        }),
        {},
      );
      expect(r).toEqual({ undoable: false, undoBlocker: deleteEvidenceBlockerText("ZSPOT", "confirmed-absent") });
    });

    it("set_impl_active: update + beforeKind enh-impl-active + captured -> undoable", () => {
      const r = writeTimeUndoability(
        entry({
          operation: "update",
          beforeKind: "enh-impl-active",
          beforeCapture: "captured",
          object: { name: "ZBADI", type: "ENHS/XS" },
        }),
        {},
      );
      expect(r).toEqual({ undoable: true, undoBlocker: "" });
    });

    it("update + beforeKind enh-impl-active but capture not captured -> generic enhancement-undo-unsupported blocker", () => {
      const r = writeTimeUndoability(
        entry({
          operation: "update",
          beforeKind: "enh-impl-active",
          beforeCapture: "failed",
          object: { name: "ZBADI", type: "ENHS/XS" },
        }),
        {},
      );
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain("Undo of an enhancement update is not supported");
    });

    it("other enhancement operations (e.g. delete, or update without enh-impl-active) are never undoable", () => {
      const r = writeTimeUndoability(
        entry({ operation: "delete", object: { name: "ZBADI", type: "ENHO/XH" } }),
        {},
      );
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain("Undo of an enhancement delete is not supported");
    });
  });

  describe("rule 6: BOPF (type BOBF)", () => {
    it("update + beforeKind bopf-model + captured -> undoable", () => {
      const r = writeTimeUndoability(
        entry({
          operation: "update",
          beforeKind: "bopf-model",
          beforeCapture: "captured",
          object: { name: "ZBO", type: "BOBF" },
        }),
        {},
      );
      expect(r).toEqual({ undoable: true, undoBlocker: "" });
    });

    it("update without a captured bopf-model before-image -> not undoable", () => {
      const r = writeTimeUndoability(
        entry({
          operation: "update",
          beforeKind: "bopf-model",
          beforeCapture: "failed",
          object: { name: "ZBO", type: "BOBF" },
        }),
        {},
      );
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toBe(
        "BOPF update has no undo: only abap_bopf_edit updates record the previous model.",
      );
    });

    it("create_bo is never undoable", () => {
      const r = writeTimeUndoability(entry({ operation: "create", object: { name: "ZBO", type: "BOBF" } }), {});
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain("BOPF create has no undo");
    });

    it("delete is never undoable", () => {
      const r = writeTimeUndoability(entry({ operation: "delete", object: { name: "ZBO", type: "BOBF" } }), {});
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain("BOPF delete has no undo");
    });
  });

  describe("rule 7: text pool (PROG/PX, CLAS/OCX, FUGR/PX)", () => {
    it.each(["PROG/PX", "CLAS/OCX", "FUGR/PX"])("%s: beforeKind text-pool + captured -> undoable", (type) => {
      const r = writeTimeUndoability(
        entry({ beforeKind: "text-pool", beforeCapture: "captured", object: { name: "Z", type } }),
        {},
      );
      expect(r).toEqual({ undoable: true, undoBlocker: "" });
    });

    it("beforeKind text-pool but capture failed -> not undoable, nothing-to-restore blocker", () => {
      const r = writeTimeUndoability(
        entry({ beforeKind: "text-pool", beforeCapture: "failed", object: { name: "Z", type: "PROG/PX" } }),
        {},
      );
      expect(r).toEqual({
        undoable: false,
        undoBlocker: "This text pool write has no recorded previous text pool, so there is nothing to restore.",
      });
    });

    it("no beforeKind at all (unexpected shape) -> same nothing-to-restore blocker, not the generic rule-11/12 path", () => {
      const r = writeTimeUndoability(
        entry({ beforeKind: undefined, beforeCapture: "captured", object: { name: "Z", type: "CLAS/OCX" } }),
        {},
      );
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain("nothing to restore");
    });
  });

  describe("rule 8: a package has no source to restore (delete only)", () => {
    it("delete of a DEVC/K -> not undoable, package-recreate blocker", () => {
      const r = writeTimeUndoability(
        entry({ operation: "delete", object: { name: "ZPACK", type: "DEVC/K" } }),
        {},
      );
      expect(r).toEqual({ undoable: false, undoBlocker: packageRecreateBlockerText("ZPACK") });
    });

    it("update of a DEVC/K (not a delete) is NOT blocked by rule 8 — falls through to the ordinary rules", () => {
      const r = writeTimeUndoability(
        entry({ operation: "update", object: { name: "ZPACK", type: "DEVC/K" } }),
        {},
      );
      expect(r).toEqual({ undoable: true, undoBlocker: "" });
    });
  });

  describe("rule 9: class sub-include create/delete has no ADT verb of its own", () => {
    const CLS_URI = "/sap/bc/adt/oo/classes/zcl_mcp_inc_undo";
    const INC_URI = `${CLS_URI}/includes/testclasses`;

    it("creating a non-main include (existedBefore false) plans a delete-undo -> blocked", () => {
      const r = writeTimeUndoability(
        entry({
          operation: "create",
          existedBefore: false,
          object: { name: "ZCL_MCP_INC_UNDO", type: "CLAS/OC", uri: CLS_URI, sourceUri: INC_URI },
        }),
        {},
      );
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain("DELETE the testclasses include of class ZCL_MCP_INC_UNDO");
      expect(r.undoBlocker).toContain("This refusal cannot be overridden with force=true");
    });

    it("deleting a non-main include plans a recreate-undo -> blocked", () => {
      const r = writeTimeUndoability(
        entry({
          operation: "delete",
          existedBefore: true,
          object: { name: "ZCL_MCP_INC_UNDO", type: "CLAS/OC", uri: CLS_URI, sourceUri: INC_URI },
        }),
        {},
      );
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain("RE-CREATE the testclasses include of class ZCL_MCP_INC_UNDO");
    });

    it("updating a non-main include that already existed plans a restore-undo -> NOT blocked by rule 9", () => {
      const r = writeTimeUndoability(
        entry({
          operation: "update",
          existedBefore: true,
          object: { name: "ZCL_MCP_INC_UNDO", type: "CLAS/OC", uri: CLS_URI, sourceUri: INC_URI },
        }),
        {},
      );
      expect(r).toEqual({ undoable: true, undoBlocker: "" });
    });

    it("the main include's sourceUri (no /includes/ suffix) is exempt from rule 9 entirely", () => {
      const r = writeTimeUndoability(
        entry({
          operation: "create",
          existedBefore: false,
          beforeCapture: "confirmed-absent",
          object: { name: "ZCL_MCP_INC_UNDO", type: "CLAS/OC", uri: CLS_URI, sourceUri: `${CLS_URI}/source/main` },
        }),
        {},
      );
      // Falls through to rule 10 instead: create + !existedBefore + confirmed-absent passes it, then
      // rule 11 is skipped (existedBefore is false and this isn't a delete), landing on rule 12.
      expect(r).toEqual({ undoable: true, undoBlocker: "" });
    });
  });

  describe("rule 10: delete-shaped without positive evidence of prior absence", () => {
    it("create + !existedBefore + capture not confirmed-absent -> blocked with the delete-evidence text", () => {
      const r = writeTimeUndoability(
        entry({ operation: "create", existedBefore: false, beforeCapture: "unknown" }),
        {},
      );
      expect(r).toEqual({ undoable: false, undoBlocker: deleteEvidenceBlockerText("ZTEST", "unknown") });
    });

    it("create + !existedBefore + confirmed-absent passes rule 10 (and, having no blob to restore, is still undoable via rule 12 since rule 11 does not apply)", () => {
      const r = writeTimeUndoability(
        entry({ operation: "create", existedBefore: false, beforeCapture: "confirmed-absent" }),
        {},
      );
      expect(r).toEqual({ undoable: true, undoBlocker: "" });
    });

    it("a delete operation is exempt from rule 10 even with existedBefore false", () => {
      const r = writeTimeUndoability(
        entry({
          operation: "delete",
          existedBefore: false,
          beforeCapture: "unknown",
          before: { etag: "e", fingerprint: "f", bytes: 1, blob: "b" },
        }),
        {},
      );
      // Rule 10 is skipped (operation === "delete"); rule 11 then requires beforeCapture === "captured".
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain("No before-image was captured for ZTEST");
    });
  });

  describe("rule 11: restore/recreate-shaped with no before-image blob to replay (the 'missing blob' case)", () => {
    it("existedBefore true, beforeCapture captured, but no blob recorded -> blocked", () => {
      const r = writeTimeUndoability(entry({ existedBefore: true, beforeCapture: "captured", before: undefined }), {});
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toBe('No before-image was captured for ZTEST (beforeCapture="captured"), so there is nothing to restore.');
    });

    it("existedBefore true, beforeCapture failed (before-read never even succeeded) -> blocked", () => {
      const r = writeTimeUndoability(entry({ existedBefore: true, beforeCapture: "failed" }), {});
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain('beforeCapture="failed"');
    });

    it("a delete with no captured before-image -> blocked (delete is restore-shaped too)", () => {
      const r = writeTimeUndoability(
        entry({ operation: "delete", existedBefore: true, beforeCapture: "unknown" }),
        {},
      );
      expect(r.undoable).toBe(false);
      expect(r.undoBlocker).toContain('beforeCapture="unknown"');
    });
  });

  describe("rule 12: nothing else applies — an ordinary restore with a real before-image", () => {
    it("a plain update with a captured before-image and a blob is undoable", () => {
      const r = writeTimeUndoability(entry(), {});
      expect(r).toEqual({ undoable: true, undoBlocker: "" });
    });

    it("a plain delete with a captured before-image and a blob is undoable too (not a special type)", () => {
      const r = writeTimeUndoability(entry({ operation: "delete" }), {});
      expect(r).toEqual({ undoable: true, undoBlocker: "" });
    });
  });
});

describe("captureExplanation", () => {
  it("has distinct, non-empty text for all four provenance values", () => {
    const values = ["failed", "unknown", "captured", "confirmed-absent"] as const;
    const texts = values.map((v) => captureExplanation(v));
    expect(new Set(texts).size).toBe(4);
    for (const t of texts) expect(t.length).toBeGreaterThan(0);
  });
});

describe("precedingWriteEntry", () => {
  const activate = entry({ id: "activate1", operation: "activate", ts: "2024-01-01T00:00:10.000Z" });

  function write(overrides: Partial<JournalEntry> & { object?: Partial<JournalEntry["object"]> } = {}): JournalEntry {
    return entry({ operation: "create", outcome: "succeeded", ts: "2024-01-01T00:00:05.000Z", ...overrides });
  }

  it("matches the same object case-insensitively (both type and name)", () => {
    const pw = write({ object: { name: "ztest", type: "prog/p" } });
    expect(precedingWriteEntry([pw], activate)).toBe(pw);
  });

  it("a different object (name or type) is skipped", () => {
    const otherName = write({ object: { name: "ZOTHER" } });
    const otherType = write({ object: { type: "CLAS/OC" } });
    expect(precedingWriteEntry([otherName, otherType], activate)).toBeUndefined();
  });

  it("an entry with a different systemKey (when activate has one) is skipped", () => {
    const act = entry({ ...activate, systemKey: "SYS1" });
    const otherSystem = write({ systemKey: "SYS2" });
    expect(precedingWriteEntry([otherSystem], act)).toBeUndefined();
  });

  it("an entry with no systemKey at all still matches, even when activate has one", () => {
    const act = entry({ ...activate, systemKey: "SYS1" });
    const noSystem = write({ systemKey: undefined });
    expect(precedingWriteEntry([noSystem], act)).toBe(noSystem);
  });

  it("failed or pending writes are skipped", () => {
    const failed = write({ outcome: "failed" });
    const pending = write({ outcome: "pending" });
    expect(precedingWriteEntry([failed, pending], activate)).toBeUndefined();
  });

  it("non-write operations (e.g. another activate) are skipped", () => {
    const otherActivate = write({ operation: "activate" });
    expect(precedingWriteEntry([otherActivate], activate)).toBeUndefined();
  });

  it("the latest of several eligible writes wins", () => {
    const older = write({ id: "w-old", ts: "2024-01-01T00:00:01.000Z" });
    const newer = write({ id: "w-new", ts: "2024-01-01T00:00:08.000Z" });
    expect(precedingWriteEntry([older, newer], activate)).toBe(newer);
    expect(precedingWriteEntry([newer, older], activate)).toBe(newer);
  });

  it("ties on ts are broken by array position — the later position wins", () => {
    const first = write({ id: "w-first", ts: "2024-01-01T00:00:05.000Z" });
    const second = write({ id: "w-second", ts: "2024-01-01T00:00:05.000Z" });
    expect(precedingWriteEntry([first, second], activate)).toBe(second);
  });

  it("when activate is itself present in entries, only writes strictly earlier (or tied and positioned before it) count", () => {
    const before = write({ id: "w-before", ts: activate.ts });
    const list = [before, activate];
    // before is at index 0, activate at index 1: tie on ts, before's index < activate's index -> earlier.
    expect(precedingWriteEntry(list, activate)).toBe(before);

    const after = write({ id: "w-after", ts: activate.ts });
    const list2 = [activate, after];
    // after is at index 1, activate at index 0: tie on ts, after's index > activate's index -> NOT earlier.
    expect(precedingWriteEntry(list2, activate)).toBeUndefined();
  });

  it("when activate is absent from entries (the real begin()-time case), every same-object write with an earlier-or-equal ts counts", () => {
    const tied = write({ id: "w-tied", ts: activate.ts });
    expect(precedingWriteEntry([tied], activate)).toBe(tied);
  });

  it("undone preceding writes are still returned — refusing to reuse an undone write is writeTimeUndoability's job, not this function's", () => {
    const undone = write({ id: "w-undone", undoneBy: "undo-1" });
    expect(precedingWriteEntry([undone], activate)).toBe(undone);
  });
});
