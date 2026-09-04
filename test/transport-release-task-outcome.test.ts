/**
 * ISSUE-TASK-02: releasing a TASK must never report `outcome: unknown`
 * next to a proven `RELEASED` verdict, and the header's `statusBefore`/
 * `statusAfter` — object-scoped everywhere else — must not silently
 * describe the PARENT for a task release.
 *
 * Reuses the fixture and helper idiom of the "a task number silently
 * resolving to its parent request is surfaced (D-23)" block in
 * test/transport-tools.test.ts: same real fixture
 * (`transport-details-task-resolves-to-parent`, A4HK900131 carrying task
 * A4HK900132), same SYNTHETIC body builders (recreated locally — they are
 * local to that file), no live access, no network.
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Journal, type JournalConfig } from "../src/journal.js";
import { SafetyGate } from "../src/safety.js";
import { abapTransportRelease, type TransportJournalDeps } from "../src/tools/transport.js";
import type { CtsScriptStep } from "./helpers/cts-fixtures.js";
import { fakeCtsConnection, loadCtsFixture } from "./helpers/cts-fixtures.js";

const MAX_CHARS = 60_000;

/** A wide-open gate: release is permitted, nothing else in play. */
function openGate(): SafetyGate {
  return new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransportRelease: true });
}

/**
 * SYNTHETIC: the real `transport-details-task-resolves-to-parent` fixture
 * with ONLY the sibling task's own `tm:status`/`tm:status_text` flipped from
 * Released back to Modifiable — the parent's own status ("D") is untouched.
 * Mirrors `taskStillOpenBody()` in test/transport-tools.test.ts; never edits
 * the fixture file itself.
 */
function taskStillOpenBody(): string {
  const real = loadCtsFixture("transport-details-task-resolves-to-parent");
  const taskMarker = '<tm:task tm:number="A4HK900132"';
  const cut = real.body.indexOf(taskMarker);
  if (cut < 0) throw new Error("fixture shape changed: sibling <tm:task> marker not found");
  const stillOpen =
    real.body.slice(0, cut) +
    real.body
      .slice(cut)
      .replace('tm:status="R" tm:status_text="Released"', 'tm:status="D" tm:status_text="Modifiable"');
  expect(stillOpen).not.toBe(real.body);
  return stillOpen;
}

/**
 * SYNTHETIC: the real fixture with the sibling `<tm:task
 * tm:number="A4HK900132">...</tm:task>` element deleted outright, so the
 * re-read carries 0 tasks and there is no row to read. Mirrors
 * `taskAbsentBody()` in test/transport-tools.test.ts.
 */
function taskAbsentBody(): string {
  const real = loadCtsFixture("transport-details-task-resolves-to-parent");
  const taskMarker = '<tm:task tm:number="A4HK900132"';
  const start = real.body.indexOf(taskMarker);
  if (start < 0) throw new Error("fixture shape changed: sibling <tm:task> marker not found");
  const closeTag = "</tm:task>";
  const end = real.body.indexOf(closeTag, start);
  if (end < 0) throw new Error("fixture shape changed: </tm:task> not found");
  const noTask = real.body.slice(0, start) + real.body.slice(end + closeTag.length);
  expect(noTask).not.toBe(real.body);
  expect(noTask).not.toContain(taskMarker);
  return noTask;
}

describe("transport release of a TASK: outcome and statusBefore/statusAfter no longer contradict the verdict (ISSUE-TASK-02)", () => {
  it("task proven released: outcome is released, not unknown, and requestedStatusAfter carries the task's own reading", async () => {
    const before: CtsScriptStep = { status: 200, body: taskStillOpenBody() };
    const release = loadCtsFixture("transport-release-success");
    const after = loadCtsFixture("transport-details-task-resolves-to-parent"); // real, unmodified — A4HK900132 reads R
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toMatch(/^outcome: released$/m);
    expect(res.text).not.toMatch(/^outcome: unknown$/m);
    expect(res.text).toContain("RELEASED — the task's own row in the parent confirms it");
    expect(res.text).toMatch(/^confirmedByReRead: true$/m);
    expect(res.text).toMatch(/^requestedStatusAfter: Released \(tm:status=R\)$/m);
  });

  it("task proven released: the parent-scoped fields are renamed, no bare statusBefore/statusAfter, and a note names requestedStatusAfter as authoritative", async () => {
    const before: CtsScriptStep = { status: 200, body: taskStillOpenBody() };
    const release = loadCtsFixture("transport-release-success");
    const after = loadCtsFixture("transport-details-task-resolves-to-parent");
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
    );

    // The field that actually changed (the task's own reading) is the one
    // named "requestedStatusAfter"; the parent-scoped reading is renamed
    // rather than reusing the object-scoped name.
    expect(res.text).toMatch(/^requestedStatusAfter: Released \(tm:status=R\)$/m);
    expect(res.text).toMatch(/^parentStatusBefore: Modifiable \(tm:status=D\)$/m);
    expect(res.text).toMatch(/^parentStatusAfter: Modifiable \(tm:status=D\)$/m);
    expect(res.text).not.toMatch(/^statusBefore:/m);
    expect(res.text).not.toMatch(/^statusAfter:/m);
    expect(res.text).toMatch(
      /requestedStatus\/requestedStatusAfter are A4HK900132's own readings and the fields to act on/,
    );
  });

  it("task released despite an abort report: outcome is released-despite-abort and the verdict still reads RELEASED", async () => {
    const before: CtsScriptStep = { status: 200, body: taskStillOpenBody() };
    const release = loadCtsFixture("transport-release-abort-task-not-released"); // envelope: aborted
    const after = loadCtsFixture("transport-details-task-resolves-to-parent"); // task row reads R
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toMatch(/^outcome: released-despite-abort$/m);
    expect(res.text).toContain("RELEASED — despite an abort report, the task's own row in the parent confirms it");
  });

  it("task genuinely not released: outcome is aborted and the verdict reads NOT RELEASED", async () => {
    const before: CtsScriptStep = { status: 200, body: taskStillOpenBody() };
    const release = loadCtsFixture("transport-release-abort-task-not-released"); // envelope: aborted
    const after: CtsScriptStep = { status: 200, body: taskStillOpenBody() }; // re-read: still Modifiable
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toMatch(/^outcome: aborted$/m);
    expect(res.text).toContain("NOT RELEASED — the release was aborted");
  });

  it("task row absent from the re-read: outcome is unknown, confirmedByReRead is false, and the verdict says COULD NOT VERIFY — never over-claimed", async () => {
    const before: CtsScriptStep = { status: 200, body: taskStillOpenBody() };
    const release = loadCtsFixture("transport-release-success"); // envelope claims released
    const after: CtsScriptStep = { status: 200, body: taskAbsentBody() }; // 0 tasks in the re-read
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toMatch(/^outcome: unknown$/m);
    expect(res.text).toMatch(/^confirmedByReRead: false$/m);
    expect(res.text).toContain("COULD NOT VERIFY — the re-read answered about a different number");
  });

  it("guard: outcome: unknown never appears alongside confirmedByReRead: true, across every shape above", async () => {
    const scripts: Array<[string, CtsScriptStep, CtsScriptStep, CtsScriptStep]> = [
      [
        "released",
        { status: 200, body: taskStillOpenBody() },
        loadCtsFixture("transport-release-success"),
        loadCtsFixture("transport-details-task-resolves-to-parent"),
      ],
      [
        "released-despite-abort",
        { status: 200, body: taskStillOpenBody() },
        loadCtsFixture("transport-release-abort-task-not-released"),
        loadCtsFixture("transport-details-task-resolves-to-parent"),
      ],
      [
        "aborted",
        { status: 200, body: taskStillOpenBody() },
        loadCtsFixture("transport-release-abort-task-not-released"),
        { status: 200, body: taskStillOpenBody() },
      ],
      [
        "unknown (absent row)",
        { status: 200, body: taskStillOpenBody() },
        loadCtsFixture("transport-release-success"),
        { status: 200, body: taskAbsentBody() },
      ],
    ];

    for (const [label, before, release, after] of scripts) {
      const { conn } = fakeCtsConnection([before, release, after]);
      const res = await abapTransportRelease(
        conn,
        { transport: "A4HK900132", confirm: "A4HK900132" },
        MAX_CHARS,
        openGate(),
      );
      const isUnknown = /^outcome: unknown$/m.test(res.text);
      const isConfirmed = /^confirmedByReRead: true$/m.test(res.text);
      expect(
        !(isUnknown && isConfirmed),
        `${label}: outcome: unknown and confirmedByReRead: true must never both appear — got:\n${res.text}`,
      ).toBe(true);
    }
  });

  it("a non-substituted REQUEST release is unchanged: statusAfter/statusBefore still render and outcome is released", async () => {
    const before = loadCtsFixture("transport-details-with-objects"); // A4HK900117, modifiable
    const release = loadCtsFixture("transport-release-success");
    const after = loadCtsFixture("transport-details-released");
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toMatch(/^outcome: released$/m);
    expect(res.text).toMatch(/^statusAfter: Released \(tm:status=R\)$/m);
    expect(res.text).not.toMatch(/^parentStatusBefore:/m);
    expect(res.text).not.toMatch(/^parentStatusAfter:/m);
  });

  // ---------------------------------------------------------------------
  // Journal after-image: `releaseAfterImage` must not drift from the
  // rendered answer. Minimal scaffolding lifted from the "journalling
  // caller-driven CTS mutations" block in test/transport-tools.test.ts.
  // ---------------------------------------------------------------------

  describe("journal after-image for a proven task release", () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "abapsmith-tr-task-outcome-journal-"));
    });

    afterEach(async () => {
      await fsp.rm(tmp, { recursive: true, force: true });
    });

    const jcfg = (dir: string): JournalConfig => ({
      dir,
      enabled: true,
      maxEntries: 200,
      maxAgeDays: 30,
    });
    const FAKE_CFG = { sid: "A4H", url: "http://a4h.example:50000", client: "001" };

    it("records outcome: released and requestedStatusAfter: Released (tm:status=R), not the parent-scoped statusAfter", async () => {
      const before: CtsScriptStep = { status: 200, body: taskStillOpenBody() };
      const release = loadCtsFixture("transport-release-success");
      const after = loadCtsFixture("transport-details-task-resolves-to-parent");
      const { conn } = fakeCtsConnection([before, release, after]);

      const deps: TransportJournalDeps = {
        journal: new Journal(jcfg(tmp), "A4H"),
        cfg: FAKE_CFG,
        warn: () => {},
      };

      await abapTransportRelease(
        conn,
        { transport: "A4HK900132", confirm: "A4HK900132" },
        MAX_CHARS,
        openGate(),
        deps,
      );

      const all = await new Journal(jcfg(tmp), "A4H").list();
      expect(all).toHaveLength(1);
      const afterBlob = await new Journal(jcfg(tmp), "A4H").afterImage(all[0]!);
      expect(afterBlob).toMatch(/^outcome: released$/m);
      expect(afterBlob).toMatch(/^requestedStatusAfter: Released \(tm:status=R\)$/m);
      expect(afterBlob).not.toMatch(/^statusAfter:/m);
    });
  });
});
