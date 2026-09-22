/**
 * `abap_transport_release` `scope: "single" | "request"` (#159).
 *
 * With `scope: "request"` and a REQUEST number, the tool releases each
 * modifiable task holding objects (in `tasks[]` order), then the request
 * itself, in one call, stopping at the first step that fails. With a TASK
 * number and no `scope`, the response additionally says whether the parent
 * still has to be released and its number.
 *
 * All request/response bodies are either real captured fixtures (replayed
 * verbatim) or SYNTHETIC bodies built by string-editing a real fixture —
 * never a hand-authored body pretending to be real wire output. Idiom and
 * scaffolding copied from test/transport-release-task-outcome.test.ts.
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { AbapError } from "../src/adt/errors.js";
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

// ---------------------------------------------------------------------------
// Synthetic body builders — each is a real fixture with ONE targeted edit.
// ---------------------------------------------------------------------------

/**
 * SYNTHETIC: `transport-details-with-objects` (request A4HK900117, task
 * A4HK900118 holding 1 object) with the TASK's own status flipped from
 * Modifiable to Released — the request's own status is untouched.
 */
function taskReleasedBody(): string {
  const real = loadCtsFixture("transport-details-with-objects");
  const taskMarker = '<tm:task tm:number="A4HK900118"';
  const cut = real.body.indexOf(taskMarker);
  if (cut < 0) throw new Error("fixture shape changed: <tm:task> marker not found");
  const released =
    real.body.slice(0, cut) +
    real.body
      .slice(cut)
      .replace('tm:status="D" tm:status_text="Modifiable"', 'tm:status="R" tm:status_text="Released"');
  expect(released).not.toBe(real.body);
  return released;
}

/**
 * SYNTHETIC: `taskReleasedBody()` with the REQUEST's own status ALSO
 * flipped to Released. The request's own `tm:status="D"` is the first
 * occurrence in the body (it precedes the task element), so a plain
 * (non-global) replace on top of `taskReleasedBody()` — whose task is
 * already "R" — lands on the request's attribute.
 */
function allReleasedBody(): string {
  const base = taskReleasedBody();
  const released = base.replace(
    'tm:status="D" tm:status_text="Modifiable"',
    'tm:status="R" tm:status_text="Released"',
  );
  expect(released).not.toBe(base);
  return released;
}

/**
 * SYNTHETIC: `transport-details-with-objects` with the TASK's own
 * `<tm:abap_object>` element removed — the task stays Modifiable but holds
 * 0 objects, so a scope=request run must skip it rather than release it.
 * The request-level `<tm:all_objects>` entry (which precedes the task
 * element in the body) is untouched.
 */
function emptyTaskBody(): string {
  const real = loadCtsFixture("transport-details-with-objects");
  const taskMarker = '<tm:task tm:number="A4HK900118"';
  const taskStart = real.body.indexOf(taskMarker);
  if (taskStart < 0) throw new Error("fixture shape changed: <tm:task> marker not found");
  const objStart = real.body.indexOf("<tm:abap_object", taskStart);
  if (objStart < 0) throw new Error("fixture shape changed: task-level <tm:abap_object> not found");
  const objCloseTag = "</tm:abap_object>";
  const objEnd = real.body.indexOf(objCloseTag, objStart);
  if (objEnd < 0) throw new Error("fixture shape changed: </tm:abap_object> not found");
  const withoutObj = real.body.slice(0, objStart) + real.body.slice(objEnd + objCloseTag.length);
  expect(withoutObj).not.toBe(real.body);
  expect(withoutObj.indexOf("ZMCP_CTS_PROBE", taskStart)).toBe(-1);
  return withoutObj;
}

/**
 * SYNTHETIC: `emptyTaskBody()` with the REQUEST's own status flipped to
 * Released — the empty task stays Modifiable, untouched.
 */
function requestReleasedEmptyTaskBody(): string {
  const base = emptyTaskBody();
  const released = base.replace(
    'tm:status="D" tm:status_text="Modifiable"',
    'tm:status="R" tm:status_text="Released"',
  );
  expect(released).not.toBe(base);
  return released;
}

/**
 * SYNTHETIC: the real `transport-details-task-resolves-to-parent` fixture
 * with ONLY the sibling task's own status flipped from Released back to
 * Modifiable — mirrors `taskStillOpenBody()` in
 * test/transport-release-task-outcome.test.ts (recreated locally, as that
 * helper is local to its own file).
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
 * SYNTHETIC: the real `transport-details-task-resolves-to-parent` fixture
 * (task A4HK900132 already Released) with the PARENT's own status ALSO
 * flipped from Modifiable to Released. The parent's `tm:status="D"` is the
 * first occurrence in the body (it precedes the task element), so a plain
 * (non-global) replace lands on the parent's attribute, not the task's
 * (already "R").
 */
function parentAlsoReleasedBody(): string {
  const real = loadCtsFixture("transport-details-task-resolves-to-parent");
  const released = real.body.replace(
    'tm:status="D" tm:status_text="Modifiable"',
    'tm:status="R" tm:status_text="Released"',
  );
  expect(released).not.toBe(real.body);
  return released;
}

// ---------------------------------------------------------------------------
// scope=request
// ---------------------------------------------------------------------------

describe("abap_transport_release scope=request (#159)", () => {
  it("releases each modifiable task holding objects, then the request, in order", async () => {
    const { conn, calls, assertExhausted } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      loadCtsFixture("transport-release-success"),
      { status: 200, body: taskReleasedBody() },
      loadCtsFixture("transport-release-success"),
      { status: 200, body: allReleasedBody() },
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117", scope: "request" },
      MAX_CHARS,
      openGate(),
    );

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.url).toContain("A4HK900118/newreleasejobs");
    expect(posts[1]?.url).toContain("A4HK900117/newreleasejobs");

    expect(res.text).toMatch(/^scope: request$/m);
    expect(res.text).toMatch(/^stepsPlanned: 2$/m);
    expect(res.text).toMatch(/^stepsCompleted: 2$/m);
    expect(res.text).toMatch(/^verdict: RELEASED — 1 task\(s\) and the request A4HK900117/m);
    expect(res.text).toContain("STEPS");
    expect(res.text).toContain("A4HK900118");
    expect(res.text).toContain("A4HK900117");
    expect(res.text).not.toMatch(/^stoppedAtStep:/m);
    assertExhausted();
  });

  it("stops at the task step and never touches the request", async () => {
    const { conn, calls, assertExhausted } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      loadCtsFixture("transport-release-abort-task-not-released"),
      loadCtsFixture("transport-details-with-objects"), // unchanged: task still D
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117", scope: "request" },
      MAX_CHARS,
      openGate(),
    );

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain("A4HK900118/newreleasejobs");

    expect(res.text).toMatch(/^verdict: STOPPED AT STEP 1 of 2 \(A4HK900118, task\) — NOT RELEASED/m);
    expect(res.text).toMatch(/^stepsCompleted: 0$/m);
    expect(res.text).toMatch(/^stoppedAtStep: 1$/m);
    expect(res.text).toContain("not attempted");
    expect(res.text).toContain("A4HK900117");
    assertExhausted();
  });

  it("stops at the request step after the task released", async () => {
    const { conn, calls, assertExhausted } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      loadCtsFixture("transport-release-success"),
      { status: 200, body: taskReleasedBody() },
      loadCtsFixture("transport-release-abort-task-not-released"),
      { status: 200, body: taskReleasedBody() },
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117", scope: "request" },
      MAX_CHARS,
      openGate(),
    );

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.url).toContain("A4HK900118/newreleasejobs");
    expect(posts[1]?.url).toContain("A4HK900117/newreleasejobs");

    expect(res.text).toMatch(/^verdict: STOPPED AT STEP 2 of 2 \(A4HK900117, request\) — NOT RELEASED/m);
    expect(res.text).toMatch(/^stepsCompleted: 1$/m);
    expect(res.text).toContain("MESSAGES");
    expect(res.text).toContain("732");
    assertExhausted();
  });

  it("a task number without scope reports the open parent and its number", async () => {
    const { conn } = fakeCtsConnection([
      { status: 200, body: taskStillOpenBody() },
      loadCtsFixture("transport-release-success"),
      loadCtsFixture("transport-details-task-resolves-to-parent"), // real, unmodified — task reads R, parent D
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toMatch(/^parent: A4HK900131$/m);
    expect(res.text).toMatch(/^parentStillOpen: yes$/m);
    expect(res.text).toContain('{"transport":"A4HK900131","confirm":"A4HK900131"');
    expect(res.text).toContain('scope: "request"');
    expect(res.text).toMatch(/^outcome: released$/m);
  });

  it("a task number without scope says the parent is done when it reads Released", async () => {
    const { conn } = fakeCtsConnection([
      { status: 200, body: taskStillOpenBody() },
      loadCtsFixture("transport-release-success"),
      { status: 200, body: parentAlsoReleasedBody() },
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toMatch(/^parentStillOpen: no$/m);
  });

  it("scope=request with a task number is refused before any release", async () => {
    const { conn, calls } = fakeCtsConnection([{ status: 200, body: taskStillOpenBody() }]);

    let caught: unknown;
    try {
      await abapTransportRelease(
        conn,
        { transport: "A4HK900132", confirm: "A4HK900132", scope: "request" },
        MAX_CHARS,
        openGate(),
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AbapError);
    const err = caught as AbapError;
    expect(err.code).toBe("BAD_INPUT");
    expect(err.details.parent).toBe("A4HK900131");
    expect(err.details.scope).toBe("request");
    expect(err.message).toContain("A4HK900131");

    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("scope=request dry run plans the steps and releases nothing", async () => {
    const { conn, calls } = fakeCtsConnection([loadCtsFixture("transport-details-with-objects")]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", scope: "request" },
      MAX_CHARS,
      openGate(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(res.text).toMatch(/^mode: dry run$/m);
    expect(res.text).toMatch(/^scope: request$/m);
    expect(res.text).toMatch(/^stepsPlanned: 2$/m);
    expect(res.text).toContain("STEPS");
    expect(res.text).toContain("DRY RUN — nothing was released.");
    expect(res.text).toContain('confirm: "A4HK900117" and scope: "request"');
  });

  it("an empty modifiable task is skipped, not released", async () => {
    const { conn, calls, assertExhausted } = fakeCtsConnection([
      { status: 200, body: emptyTaskBody() },
      loadCtsFixture("transport-release-success"),
      { status: 200, body: requestReleasedEmptyTaskBody() },
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117", scope: "request" },
      MAX_CHARS,
      openGate(),
    );

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain("A4HK900117/newreleasejobs");

    expect(res.text).toMatch(/^stepsPlanned: 1$/m);
    expect(res.text).toContain("A4HK900118");
    expect(res.text).toContain("skipped");
    assertExhausted();
  });

  describe("journals one entry per attempted step", () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "abapsmith-tr-scope-request-journal-"));
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

    it("task released, request aborted: one succeeded entry and one failed entry, both operation transport-release", async () => {
      const { conn } = fakeCtsConnection([
        loadCtsFixture("transport-details-with-objects"),
        loadCtsFixture("transport-release-success"),
        { status: 200, body: taskReleasedBody() },
        loadCtsFixture("transport-release-abort-task-not-released"),
        { status: 200, body: taskReleasedBody() },
      ]);

      const deps: TransportJournalDeps = {
        journal: new Journal(jcfg(tmp), "A4H"),
        cfg: FAKE_CFG,
        warn: () => {},
      };

      await abapTransportRelease(
        conn,
        { transport: "A4HK900117", confirm: "A4HK900117", scope: "request" },
        MAX_CHARS,
        openGate(),
        deps,
      );

      const all = await new Journal(jcfg(tmp), "A4H").list();
      const releaseEntries = all.filter((e) => e.operation === "transport-release");
      expect(releaseEntries).toHaveLength(2);

      const task = releaseEntries.find((e) => e.corrNr === "A4HK900118");
      expect(task?.outcome).toBe("succeeded");
      const request = releaseEntries.find((e) => e.corrNr === "A4HK900117");
      expect(request?.outcome).toBe("failed");
    });

    it("stops at the task step: exactly one failed entry", async () => {
      const { conn } = fakeCtsConnection([
        loadCtsFixture("transport-details-with-objects"),
        loadCtsFixture("transport-release-abort-task-not-released"),
        loadCtsFixture("transport-details-with-objects"),
      ]);

      const deps: TransportJournalDeps = {
        journal: new Journal(jcfg(tmp), "A4H"),
        cfg: FAKE_CFG,
        warn: () => {},
      };

      await abapTransportRelease(
        conn,
        { transport: "A4HK900117", confirm: "A4HK900117", scope: "request" },
        MAX_CHARS,
        openGate(),
        deps,
      );

      const all = await new Journal(jcfg(tmp), "A4H").list();
      const releaseEntries = all.filter((e) => e.operation === "transport-release");
      expect(releaseEntries).toHaveLength(1);
      expect(releaseEntries[0]?.corrNr).toBe("A4HK900118");
      expect(releaseEntries[0]?.outcome).toBe("failed");
    });
  });

  it("refuses armed scope=request when the ceiling forbids release, with zero wire requests", async () => {
    // Per src/safety.ts:1437-1442, a closed `allowTransportRelease` ceiling
    // (with writes otherwise on) is deliberately coded READ_ONLY, not
    // SAFETY_DENIED — that taxonomy predates #159 and is unrelated to it, so
    // this test targets the real, documented code rather than SAFETY_DENIED.
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransportRelease: false });
    const { conn, calls } = fakeCtsConnection([]);

    await expect(
      abapTransportRelease(
        conn,
        { transport: "A4HK900117", confirm: "A4HK900117", scope: "request" },
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });

    expect(calls).toHaveLength(0);
  });
});
