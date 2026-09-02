/**
 * `SessionTransport` under `allowTransports: ["auto"]` used to always create a
 * fresh request. It now ADOPTS an existing candidate when it can attribute that
 * candidate to abapsmith itself — see `#resolveAuto` in src/adt/session-transport.ts.
 *
 * "Attributed" means ALL of: `kind === "workbench"` (excludes tasks), `status ===
 * "modifiable"`, `owner` equals `whoami()` case-insensitively, and `description`
 * is one abapsmith itself writes (an exact trimmed match against the configured
 * `description` option, or else `/^abapsmith session \d{4}-\d{2}-\d{2}$/`). There is
 * no uniqueness requirement — many attributed candidates is normal, and the greatest
 * `lastChanged` wins, tie-broken by the greatest `trkorr`.
 *
 * Entirely offline: no appliance, no fixtures on the wire. Same idiom as
 * test/session-transport-revalidate.test.ts — `authorizeCreate` mints the gate token
 * `trCreate` requires, and the CTS client is an injected fake.
 */
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError } from "../src/adt/errors.js";
import { SessionTransport } from "../src/adt/session-transport.js";
import type { TrHeader, TrRequirement } from "../src/adt/transports.js";
import { SafetyGate } from "../src/safety.js";

const authorizeCreate = (devClass: string) =>
  new SafetyGate({ readOnly: false, allowPackages: ["*"] }).authorize(
    "transport",
    { name: devClass, packageName: devClass },
    { corr: { kind: "unresolved" } },
  );

const OBJ_URI = "/sap/bc/adt/programs/programs/zmcp_demo/source/main";
const conn = {} as AbapConnection;
const target = { uri: OBJ_URI, name: "ZMCP_DEMO", type: "PROG/P", devclass: "ZPKG" };

/** A minimal, always-valid transportable `TrRequirement`. Only the fields
 * `resolve()` reads matter — same idiom as `transportableReq` in
 * test/session-transport-journal.test.ts. */
const transportableReq = (overrides: Partial<TrRequirement> = {}): TrRequirement =>
  ({
    uri: OBJ_URI,
    operation: "I",
    devclass: "ZPKG",
    candidates: [],
    locks: [],
    messages: [],
    checkFailed: false,
    raw: { result: "S", korrflag: "X", recording: "" },
    kind: "transport-required",
    mustSupplyCorrNr: true,
    serverWouldFabricate: false,
    ...overrides,
  }) as unknown as TrRequirement;

/** A CTS candidate header. */
const candidate = (overrides: Partial<TrHeader> = {}): TrHeader => ({
  trkorr: "A4HK900131",
  kind: "workbench",
  kindRaw: "K",
  status: "modifiable",
  statusRaw: "D",
  owner: "DEVELOPER",
  description: "a request CTS offered",
  ...overrides,
});

/** A candidate carrying abapsmith's default session description for today. */
const abapsmithCandidate = (overrides: Partial<TrHeader> = {}): TrHeader =>
  candidate({ description: "abapsmith session 2026-08-20", ...overrides });

describe("SessionTransport adopts an attributed candidate instead of creating", () => {
  it("adopts a single attributed candidate instead of creating", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const cand = abapsmithCandidate({ trkorr: "A4HK900142", owner: "DEVELOPER" });
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [cand] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("session-adopted");
    expect(res.corrNr).toBe(cand.trkorr);
    expect(res.created).toBe(false);
    expect(res.pinned).toBe(false);
    expect(res.reason).toBe(
      `Adopted existing request ${cand.trkorr} rather than creating another: it is a modifiable ` +
        `workbench request owned by DEVELOPER and carries abapsmith's own session description ` +
        `(${cand.description}). THIS SESSION DID NOT CREATE IT — it was already open when this ` +
        `session started, so it may already hold objects from earlier work, and ` +
        `abap_transport_release will refuse to release it without an explicit override.`,
    );
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("adopts the most recently changed of several attributed candidates — no uniqueness required", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const older = abapsmithCandidate({ trkorr: "A4HK900101", lastChanged: "2026-08-20 09:00:00" });
    const newest = abapsmithCandidate({ trkorr: "A4HK900102", lastChanged: "2026-08-26 17:45:10" });
    const middle = abapsmithCandidate({ trkorr: "A4HK900103", lastChanged: "2026-08-22 11:00:00" });
    const trRequirement = vi.fn(async () =>
      transportableReq({ candidates: [older, newest, middle] }),
    );
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("session-adopted");
    expect(res.corrNr).toBe(newest.trkorr);
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("breaks a lastChanged tie by the greatest trkorr", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const lower = abapsmithCandidate({ trkorr: "A4HK900101", lastChanged: "2026-08-20 09:00:00" });
    const higher = abapsmithCandidate({ trkorr: "A4HK900199", lastChanged: "2026-08-20 09:00:00" });
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [lower, higher] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.corrNr).toBe(higher.trkorr);
  });

  it("a missing lastChanged loses to a candidate that has one, regardless of trkorr order", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    // trkorr alone would pick the missing one if lastChanged weren't compared first.
    const missing = abapsmithCandidate({ trkorr: "A4HK900999", lastChanged: undefined });
    const dated = abapsmithCandidate({ trkorr: "A4HK900100", lastChanged: "2026-08-20 09:00:00" });
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [missing, dated] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.corrNr).toBe(dated.trkorr);
  });

  it("does not steal a human's request just because it is a modifiable workbench request they own", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900777", path: "/x/A4HK900777" }));
    const lesson17 = candidate({
      trkorr: "A4HK900201",
      owner: "DEVELOPER",
      description: "Lesson 17: BAdIs and code enhancements",
    });
    const lesson10 = candidate({
      trkorr: "A4HK900202",
      owner: "DEVELOPER",
      description: "ZTMD Lesson 10 - Function Modules",
    });
    const trRequirement = vi.fn(async () =>
      transportableReq({ candidates: [lesson17, lesson10] }),
    );
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("session-created");
    expect(res.corrNr).toBe("A4HK900777");
    expect(trCreate).toHaveBeenCalledTimes(1);
    const decline =
      "CTS offered 2 candidate request(s) for package ZPKG, none of which this session created " +
      "or could attribute to itself (a modifiable workbench request owned by DEVELOPER carrying " +
      "abapsmith's own session description).";
    expect(res.reason).toBe(`Created request A4HK900777 for this session. ${decline}`);
  });

  it("does not adopt a candidate owned by someone else, even with abapsmith's own description", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900778", path: "/x/A4HK900778" }));
    const othersReq = abapsmithCandidate({ trkorr: "A4HK900203", owner: "OTHERUSER" });
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [othersReq] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("session-created");
    expect(trCreate).toHaveBeenCalledTimes(1);
  });

  it("does not adopt a released request, nor a task, even when owner and description match", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900779", path: "/x/A4HK900779" }));
    const released = abapsmithCandidate({
      trkorr: "A4HK900204",
      owner: "DEVELOPER",
      status: "released",
      statusRaw: "R",
    });
    const task = abapsmithCandidate({
      trkorr: "A4HK900205",
      owner: "DEVELOPER",
      kind: "task",
      kindRaw: "S",
    });
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [released, task] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("session-created");
    expect(trCreate).toHaveBeenCalledTimes(1);
  });

  it("adopts nothing when whoami() is unknown, even given an otherwise perfectly attributed candidate", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900780", path: "/x/A4HK900780" }));
    const perfect = abapsmithCandidate({ trkorr: "A4HK900206", owner: "DEVELOPER" });
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [perfect] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => undefined,
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("session-created");
    expect(res.reason).toBe(
      "Created request A4HK900780 for this session. The connected SAP user could not be " +
        "established, so no existing request could be attributed to abapsmith (and none was " +
        "created by this session either).",
    );
  });

  it("an operator-configured description replaces the default pattern in both directions", async () => {
    const trCreateA = vi.fn(async () => ({ trkorr: "A4HK900781", path: "/x/A4HK900781" }));
    const custom = candidate({
      trkorr: "A4HK900207",
      owner: "DEVELOPER",
      description: "my custom tag",
    });
    const trRequirementA = vi.fn(async () => transportableReq({ candidates: [custom] }));
    const mgrA = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      description: "my custom tag",
      cts: { trRequirement: trRequirementA, trCreate: trCreateA } as never,
    });

    const resA = await mgrA.resolve(conn, target);
    if (resA.outcome !== "transport") throw new Error("unreachable");
    expect(resA.source).toBe("session-adopted");
    expect(resA.corrNr).toBe(custom.trkorr);
    expect(trCreateA).not.toHaveBeenCalled();

    const trCreateB = vi.fn(async () => ({ trkorr: "A4HK900782", path: "/x/A4HK900782" }));
    const defaultPattern = abapsmithCandidate({ trkorr: "A4HK900208", owner: "DEVELOPER" });
    const trRequirementB = vi.fn(async () => transportableReq({ candidates: [defaultPattern] }));
    const mgrB = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      description: "my custom tag",
      cts: { trRequirement: trRequirementB, trCreate: trCreateB } as never,
    });

    const resB = await mgrB.resolve(conn, target);
    if (resB.outcome !== "transport") throw new Error("unreachable");
    expect(resB.source).toBe("session-created");
    expect(trCreateB).toHaveBeenCalledTimes(1);
  });

  it("announces the adoption through lastAutoDecision", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const cand = abapsmithCandidate({ trkorr: "A4HK900209", owner: "DEVELOPER" });
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [cand] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(mgr.lastAutoDecision).toEqual({
      trkorr: cand.trkorr,
      source: "session-adopted",
      reason: res.reason,
    });
  });

  it("describe() renders an adopted request as adopted, not created", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const cand = abapsmithCandidate({ trkorr: "A4HK900210", owner: "DEVELOPER" });
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [cand] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    await mgr.resolve(conn, target);
    expect(mgr.describe()).toMatch(/^transport: A4HK\d+ \(session, adopted /);
    expect(mgr.describe()).toContain(", package ZPKG)");
  });

  it("a second resolve() after an adoption reuses the cached request rather than re-adopting", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const trShow = vi.fn(async () => ({
      trkorr: "A4HK900211",
      kind: "workbench" as const,
      kindRaw: "K",
      status: "modifiable" as const,
      statusRaw: "D",
      owner: "DEVELOPER",
      description: "abapsmith session 2026-08-20",
      tasks: [],
      objects: [],
    }));
    const adopted = abapsmithCandidate({ trkorr: "A4HK900211", owner: "DEVELOPER" });
    let call = 0;
    const trRequirement = vi.fn(async () => {
      call++;
      // The second call's candidate list corroborates the adopted TRKORR as
      // still modifiable, so the trShow revalidation layer does not probe.
      return call === 1
        ? transportableReq({ candidates: [adopted] })
        : transportableReq({
            candidates: [candidate({ trkorr: adopted.trkorr, status: "modifiable", owner: "DEVELOPER" })],
          });
    });
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate, trShow } as never,
    });

    const first = await mgr.resolve(conn, target);
    if (first.outcome !== "transport") throw new Error("unreachable");
    expect(first.source).toBe("session-adopted");

    const second = await mgr.resolve(conn, target);
    if (second.outcome !== "transport") throw new Error("unreachable");
    expect(second.source).toBe("session-cached");
    expect(second.corrNr).toBe(adopted.trkorr);
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("a request the trShow probe just released is not re-adopted as the only attributed candidate", async () => {
    const cachedTrkorr = "A4HK900301";
    const freshTrkorr = "A4HK900302";
    let createCall = 0;
    const trCreate = vi.fn(async () => {
      createCall++;
      const trkorr = createCall === 1 ? cachedTrkorr : freshTrkorr;
      return { trkorr, path: `/x/${trkorr}` };
    });
    const trShow = vi.fn(async () => ({
      trkorr: cachedTrkorr,
      kind: "workbench" as const,
      kindRaw: "K",
      status: "released" as const,
      statusRaw: "R",
      owner: "DEVELOPER",
      description: "abapsmith session 2026-08-20",
      tasks: [],
      objects: [],
    }));
    // CTS's own pre-flight still lists the cached request as modifiable and
    // attributed, even though trShow (the fresher evidence) says released.
    const staleAttributed = abapsmithCandidate({ trkorr: cachedTrkorr, owner: "DEVELOPER" });
    let call = 0;
    const trRequirement = vi.fn(async () => {
      call++;
      return call === 1
        ? transportableReq({ candidates: [] })
        : transportableReq({ candidates: [staleAttributed] });
    });
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate, trShow } as never,
    });

    const first = await mgr.resolve(conn, target);
    if (first.outcome !== "transport") throw new Error("unreachable");
    expect(first.corrNr).toBe(cachedTrkorr);

    const second = await mgr.resolve(conn, target, "I", { revalidate: true });
    if (second.outcome !== "transport") throw new Error("unreachable");
    expect(second.corrNr).not.toBe(cachedTrkorr);
    expect(second.corrNr).toBe(freshTrkorr);
    expect(second.source).toBe("session-created");
    expect(second.reason).toMatch(/is no longer usable \(released\)/);
    expect(second.reason).toContain(`Created request ${freshTrkorr}`);
  });

  it("a request the trShow probe just released loses adoption even as the newest attributed candidate", async () => {
    const cachedTrkorr = "A4HK900303";
    const freshTrkorr = "A4HK900304";
    let createCall = 0;
    const trCreate = vi.fn(async () => {
      createCall++;
      const trkorr = createCall === 1 ? cachedTrkorr : freshTrkorr;
      return { trkorr, path: `/x/${trkorr}` };
    });
    const trShow = vi.fn(async () => ({
      trkorr: cachedTrkorr,
      kind: "workbench" as const,
      kindRaw: "K",
      status: "released" as const,
      statusRaw: "R",
      owner: "DEVELOPER",
      description: "abapsmith session 2026-08-20",
      tasks: [],
      objects: [],
    }));
    const retiredButNewest = abapsmithCandidate({
      trkorr: cachedTrkorr,
      owner: "DEVELOPER",
      lastChanged: "2026-08-27 12:00:00",
    });
    const olderButOpen = abapsmithCandidate({
      trkorr: "A4HK900305",
      owner: "DEVELOPER",
      lastChanged: "2026-08-20 09:00:00",
    });
    let call = 0;
    const trRequirement = vi.fn(async () => {
      call++;
      return call === 1
        ? transportableReq({ candidates: [] })
        : transportableReq({ candidates: [retiredButNewest, olderButOpen] });
    });
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate, trShow } as never,
    });

    const first = await mgr.resolve(conn, target);
    if (first.outcome !== "transport") throw new Error("unreachable");
    expect(first.corrNr).toBe(cachedTrkorr);

    const second = await mgr.resolve(conn, target, "I", { revalidate: true });
    if (second.outcome !== "transport") throw new Error("unreachable");
    expect(second.source).toBe("session-adopted");
    expect(second.corrNr).toBe(olderButOpen.trkorr);
    expect(second.corrNr).not.toBe(cachedTrkorr);
  });
});

describe("SessionTransport prefers a request THIS SESSION created over one merely attributed", () => {
  it("prefers a session-created candidate over an equally-eligible abapsmith-described stranger with a NEWER lastChanged", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const ours = candidate({
      trkorr: "A4HK900401",
      owner: "DEVELOPER",
      description: "abapsmith session 2026-08-20",
      lastChanged: "2026-08-01 09:00:00",
    });
    const strangerNewer = abapsmithCandidate({
      trkorr: "A4HK900402",
      owner: "DEVELOPER",
      lastChanged: "2026-08-27 23:00:00",
    });
    const trRequirement = vi.fn(async () =>
      transportableReq({ candidates: [ours, strangerNewer] }),
    );
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });
    mgr.noteCreated(ours.trkorr);

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("session-adopted");
    expect(res.corrNr).toBe(ours.trkorr);
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("adopts a session-created candidate even when its owner differs from whoami() and its description is nothing abapsmith would write", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const ours = candidate({
      trkorr: "A4HK900403",
      owner: "OTHERUSER",
      description: "Lesson 17: BAdIs and code enhancements",
    });
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [ours] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });
    mgr.noteCreated(ours.trkorr);

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("session-adopted");
    expect(res.corrNr).toBe(ours.trkorr);
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("noteCreated() from outside the auto-resolve path (abap_transport operation=create) is adopted by a later resolve() instead of creating", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const madeElsewhere = candidate({
      trkorr: "A4HK900404",
      owner: "DEVELOPER",
      description: "whatever the operator typed",
    });
    const trRequirement = vi.fn(async () =>
      transportableReq({ candidates: [madeElsewhere] }),
    );
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    mgr.noteCreated(madeElsewhere.trkorr);
    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("session-adopted");
    expect(res.corrNr).toBe(madeElsewhere.trkorr);
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("switches from a stranger-adopted cached request to a session-created candidate, reporting the switch", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const stranger = abapsmithCandidate({ trkorr: "A4HK900405", owner: "DEVELOPER" });
    const ours = candidate({ trkorr: "A4HK900406", owner: "DEVELOPER", description: "n/a" });
    let call = 0;
    const trRequirement = vi.fn(async () => {
      call++;
      return call === 1
        ? transportableReq({ candidates: [stranger] })
        : transportableReq({ candidates: [ours] });
    });
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const first = await mgr.resolve(conn, target);
    if (first.outcome !== "transport") throw new Error("unreachable");
    expect(first.source).toBe("session-adopted");
    expect(first.corrNr).toBe(stranger.trkorr);

    // Simulates this session creating `ours` outside the auto-resolve path.
    mgr.noteCreated(ours.trkorr);

    const second = await mgr.resolve(conn, target);
    if (second.outcome !== "transport") throw new Error("unreachable");
    expect(second.source).toBe("session-adopted");
    expect(second.corrNr).toBe(ours.trkorr);
    expect(second.reason).toBe(
      `Switched from ${stranger.trkorr}, which this session did not create, to ${ours.trkorr}, ` +
        `which THIS SESSION created.`,
    );
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("keeps reusing a request this session DID create (session-cached), even when another session-created candidate is on offer", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900407", path: "/x/A4HK900407" }));
    let call = 0;
    const trRequirement = vi.fn(async () => {
      call++;
      if (call === 1) return transportableReq({ candidates: [] });
      // The cached request corroborates as modifiable, and a second
      // session-created candidate is also on offer — must not switch.
      return transportableReq({
        candidates: [
          candidate({ trkorr: "A4HK900407", owner: "DEVELOPER", status: "modifiable" }),
          candidate({ trkorr: "A4HK900408", owner: "DEVELOPER", status: "modifiable" }),
        ],
      });
    });
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const first = await mgr.resolve(conn, target);
    if (first.outcome !== "transport") throw new Error("unreachable");
    expect(first.source).toBe("session-created");
    expect(first.corrNr).toBe("A4HK900407");

    // Another request also created by this session, offered as a candidate —
    // must not steal the cached one from itself.
    mgr.noteCreated("A4HK900408");

    const second = await mgr.resolve(conn, target);
    if (second.outcome !== "transport") throw new Error("unreachable");
    expect(second.source).toBe("session-cached");
    expect(second.corrNr).toBe("A4HK900407");
    expect(trCreate).toHaveBeenCalledTimes(1);
  });

  it("still adopts a merely-attributed candidate when no session-created candidate exists, saying plainly this session did not create it", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const stranger = abapsmithCandidate({ trkorr: "A4HK900409", owner: "DEVELOPER" });
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [stranger] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("session-adopted");
    expect(res.corrNr).toBe(stranger.trkorr);
    expect(res.reason).toContain("THIS SESSION DID NOT CREATE IT");
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("createdThisSession() is true for a request the manager auto-created, and false for an adopted stranger", async () => {
    const trCreateA = vi.fn(async () => ({ trkorr: "A4HK900410", path: "/x/A4HK900410" }));
    const trRequirementA = vi.fn(async () => transportableReq({ candidates: [] }));
    const mgrA = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement: trRequirementA, trCreate: trCreateA } as never,
    });
    const resA = await mgrA.resolve(conn, target);
    if (resA.outcome !== "transport") throw new Error("unreachable");
    expect(resA.source).toBe("session-created");
    expect(mgrA.createdThisSession(resA.corrNr)).toBe(true);
    expect(mgrA.createdThisSession(resA.corrNr.toLowerCase())).toBe(true);
    expect(mgrA.createdThisSession("A4HK999999")).toBe(false);

    const trCreateB = vi.fn(async () => ({ trkorr: "A4HK900999", path: "/x/A4HK900999" }));
    const strangerAdopted = abapsmithCandidate({ trkorr: "A4HK900411", owner: "DEVELOPER" });
    const trRequirementB = vi.fn(async () =>
      transportableReq({ candidates: [strangerAdopted] }),
    );
    const mgrB = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement: trRequirementB, trCreate: trCreateB } as never,
    });
    const resB = await mgrB.resolve(conn, target);
    if (resB.outcome !== "transport") throw new Error("unreachable");
    expect(resB.source).toBe("session-adopted");
    expect(mgrB.createdThisSession(resB.corrNr)).toBe(false);
  });
});

/**
 * `parsePolicy`'s auto-create matrix. `*` now implies `auto` — the default
 * unset config resolves to `["*"]`, and safety.ts step 10 already
 * permits an auto-selected transport under `*` (it short-circuits on
 * `normalized.includes("*")`), so refusing to auto-*create* one here would
 * be `SessionTransport` disagreeing with the gate about what `*` means.
 * A pinned list must NOT gain auto-create as a side effect of this — that
 * would let an auto-created request slip a vetted, specific allowlist.
 */
describe("parsePolicy: * implies auto-create", () => {
  it('allowTransports: ["*"] permits auto-create, matching what the safety gate already allows', async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "ZTMK900801", path: "/x/ZTMK900801" }));
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [] }));
    const mgr = new SessionTransport({
      allowTransports: ["*"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("session-created");
    expect(res.corrNr).toBe("ZTMK900801");
    expect(trCreate).toHaveBeenCalledTimes(1);
  });

  it('allowTransports: ["auto"] still permits auto-create, unchanged', async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "ZTMK900802", path: "/x/ZTMK900802" }));
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [] }));
    const mgr = new SessionTransport({
      allowTransports: ["auto"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    if (res.outcome !== "transport") throw new Error("unreachable");
    expect(res.source).toBe("session-created");
    expect(trCreate).toHaveBeenCalledTimes(1);
  });

  it("allowTransports: [] still denies every transportable write — the fail-closed pin is untouched", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "ZTMK900803", path: "/x/ZTMK900803" }));
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [] }));
    const mgr = new SessionTransport({
      allowTransports: [],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate } as never,
    });

    const res = await mgr.resolve(conn, target);
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") throw new Error("unreachable");
    expect(res.denial).toBe("transports-disabled");
    expect(trCreate).not.toHaveBeenCalled();
  });

  it("a pinned-only list (e.g. a single TRKORR) still refuses auto-create — the non-weakening pin", async () => {
    const trCreate = vi.fn(async () => ({ trkorr: "ZTMK900804", path: "/x/ZTMK900804" }));
    const trRequirement = vi.fn(async () => transportableReq({ candidates: [] }));
    // The pin doesn't actually exist on this fake system — proves the point
    // more strongly than a successful pin would: even when the ONLY pin is
    // unusable, resolution stays inside pinned mode (denied) rather than
    // falling through to step 7 and creating a substitute.
    const trShow = vi.fn(async () => {
      throw new AbapError("TRANSPORT_GONE", "Transport request ZTMK900001 does not exist.");
    });
    const mgr = new SessionTransport({
      allowTransports: ["ZTMK900001"],
      authorizeCreate,
      whoami: () => "DEVELOPER",
      cts: { trRequirement, trCreate, trShow } as never,
    });

    const res = await mgr.resolve(conn, target);
    expect(res.outcome).toBe("denied");
    if (res.outcome !== "denied") throw new Error("unreachable");
    expect(res.denial).toBe("no-usable-pin");
    expect(trCreate).not.toHaveBeenCalled();
  });
});
