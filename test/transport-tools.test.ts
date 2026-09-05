/**
 * `src/tools/transport.ts` — the MCP tool surface over CTS, offline.
 *
 * This is the layer ABOVE `src/adt/transports.ts` (covered by
 * `test/transports-parse.test.ts` and `test/transports-verify.test.ts`):
 * `abapTransport`'s eight operations and `abapTransportRelease`'s dry-run /
 * armed contract, exercised through `fakeCtsConnection` against real wire
 * fixtures wherever one exists. No network, no live appliance, no `.env`.
 *
 * `trAddUser`/`trSetOwner` have no captured wire fixture (the module's own
 * source comment says so — "No fixture exists for this response"), so their
 * tests below use hand-built synthetic bodies, structurally matching what
 * `tmAction`'s XML shape implies. Everything else reuses a fixture from
 * `test/fixtures/cts/`.
 *
 * There is deliberately no schema-size budget or byte ceiling anywhere in
 * this file. `test/tools.test.ts`'s "tool surface" describe block explains
 * why: a pinned byte total (whole-server or per-tool) fails the build on
 * every prose edit, not just on genuine unbounded growth, and the fix under
 * time pressure is trimming prose to fit a number instead of improving it.
 */
import { promises as fsp, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AbapError } from "../src/adt/errors.js";
import { Journal, systemKey, type JournalConfig, type JournalEntry } from "../src/journal.js";
import { SafetyGate } from "../src/safety.js";
import {
  abapTransport,
  abapTransportRelease,
  transportInputSchema,
  transportReleaseInputSchema,
  type TransportInput,
  type TransportJournalDeps,
  type TransportReleaseInput,
} from "../src/tools/transport.js";
import type { CtsScriptStep, FakeSearchObject } from "./helpers/cts-fixtures.js";
import {
  fakeCtsConnection,
  loadCtsFixture,
  trListRequest,
  trListWorkbenchBody,
} from "./helpers/cts-fixtures.js";

const MAX_CHARS = 60_000;

/** A wide-open gate: write, release, and delete are all permitted, nothing else in play. */
function openGate(): SafetyGate {
  return new SafetyGate({
    readOnly: false,
    allowPackages: ["*"],
    allowTransportRelease: true,
    // Without this, `opDelete`'s new allowTransportDelete
    // ceiling (src/tools/transport.ts) fails closed and every delete-
    // operation test in this file refuses before any network call — this
    // gate promises "wide open", so it must carry the delete ceiling too.
    allowTransportDelete: true,
  });
}

/** A fully closed gate: no write of any kind is permitted. */
function closedGate(): SafetyGate {
  return new SafetyGate({ readOnly: true, allowPackages: [] });
}

/** Minimal `TransportInput`; callers override only the fields the op needs. */
function transportInput(partial: Partial<TransportInput> & { operation: TransportInput["operation"] }): TransportInput {
  return {
    transport: undefined,
    user: undefined,
    object: undefined,
    package: undefined,
    description: undefined,
    confirm: undefined,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Synthetic bodies for trAddUser / trSetOwner — no captured fixture exists.
// See `src/adt/transports.ts`'s `tmAction()`/`trAddUser`/`trSetOwner` for the
// shape this mirrors: a self-closing `tm:root`, optionally with a `tm:task`
// child, both under the `http://www.sap.com/cts/adt/tm` namespace (stripped
// by the parser's `removeNSPrefix: true`).
// ---------------------------------------------------------------------------

function addUserBodyWithTask(trkorr: string, task: string): CtsScriptStep {
  return {
    status: 200,
    body:
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:number="${trkorr}">` +
      `<tm:task tm:number="${task}"/></tm:root>`,
  };
}

function addUserBodyNoTask(trkorr: string): CtsScriptStep {
  // `created = attr(child(root,"task"),"number") || attr(root,"number")`. With
  // no <task> child, `created` falls back to the root's own number, which
  // equals `trkorr` — so `trAddUser` treats that as "nothing new reported".
  return {
    status: 200,
    body: `<?xml version="1.0" encoding="UTF-8"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:number="${trkorr}"/>`,
  };
}

/** `trSetOwner` never parses its response body — any 200 is sufficient. */
function setOwnerOkBody(): CtsScriptStep {
  return { status: 200, body: "" };
}

// ---------------------------------------------------------------------------
// Structural denial (§0-LIVE / module doc comment): no lock-ignoring or
// check-bypassing escape hatch anywhere in this module's schemas or source.
// ---------------------------------------------------------------------------

describe("structural denial: no ignoreLocks / ignoreAtc / force / skipChecks escape hatch", () => {
  const FORBIDDEN = /ignorelocks|ignoreatc|relwithignlock|relobjigchkatc/i;

  it("neither tool's raw input-schema shape declares a key or describe() text naming the forbidden flags", () => {
    for (const [name, schema] of [
      ["transportInputSchema", transportInputSchema],
      ["transportReleaseInputSchema", transportReleaseInputSchema],
    ] as const) {
      for (const [key, field] of Object.entries(schema)) {
        expect(key, `${name}.${key}`).not.toMatch(FORBIDDEN);
        const desc = (field as { description?: string }).description ?? "";
        expect(desc, `${name}.${key}.description`).not.toMatch(FORBIDDEN);
      }
    }
  });

  it("the module's own source text contains no reference to the denied URL variants or a force/skipChecks argument", () => {
    const path = fileURLToPath(new URL("../src/tools/transport.ts", import.meta.url));
    const src = readFileSync(path, "utf8");
    expect(src).not.toMatch(FORBIDDEN);
    // The two literal query-string/flag names §0-LIVE names as structurally
    // denied at the URL-guard layer (out of scope here — see
    // test/http-guard-transport-release-policy.test.ts) must not even be
    // spelled out as strings in this module, since that module offers no way
    // to ask for them.
    expect(src).not.toContain("ignoreLocks");
    expect(src).not.toContain("IgnoreATC");
  });

  it("a full release call sequence never issues a request whose URL names either denied release variant", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const release = loadCtsFixture("transport-release-success");
    const after = loadCtsFixture("transport-details-released");
    const { conn, calls } = fakeCtsConnection([before, release, after]);
    await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );
    for (const call of calls) {
      expect(call.url).not.toMatch(FORBIDDEN);
    }
  });
});

describe("abap_transport operation param: required-argument map", () => {
  it("states each operation's required args compactly, alongside the write/delete access rules", () => {
    const desc = transportInputSchema.operation.description ?? "";
    expect(desc).toContain("list/users none");
    expect(desc).toContain("show transport");
    expect(desc).toContain("check object");
    expect(desc).toContain("create package+description");
    expect(desc).toContain("addUser/setOwner transport+user");
    expect(desc).toContain("delete transport+confirm");
    expect(desc).toContain("removeObject transport+object+confirm");
    expect(desc).toMatch(/removeObject.*admin-only.*confirm/s);
  });
});

// ---------------------------------------------------------------------------
// abap_transport: list
// ---------------------------------------------------------------------------

describe("abap_transport operation: list", () => {
  // Without a `configUri`, the plain list endpoint never
  // returns Modifiable requests, no matter what `user`/`targets` are set to
  // — confirmed live against A4H. `opList` now resolves a search
  // configuration first: reuse one if it already exists (no authorization
  // needed at all — proven below by using a fully CLOSED gate), or create
  // one if none exists and a write is already authorized, or fall back to
  // an honest warning if neither applies. These three tests cover each of
  // those three paths.

  it("reuses an existing search configuration with no write and no authorization needed, and renders Modifiable requests normally", async () => {
    // The discovery step's body is the real captured plural-list response
    // (test/fixtures/cts/transport-search-configurations-list.xml, captured
    // live against A4H 2026-08-07 while two genuine search-configuration
    // objects existed server-side). This is the shape that exposed the
    // original live bug: each entry's atom:link carries
    // rel="http://www.sap.com/adt/categories/configurations", NEVER
    // rel="self" (contrast the singular create-response fixture used
    // elsewhere in this file, which does use rel="self") — matching on
    // rel="self" alone found zero entries against this real shape, so `list`
    // could never actually discover-and-reuse an existing configuration live,
    // only ever create new ones. `parseSearchConfigurations` now matches on
    // the link's `type` attribute instead (stable across both shapes), and
    // this is confirmed against real bytes in this PR's live-verification
    // pass.
    const discovery = loadCtsFixture("transport-search-configurations-list");
    const list = loadCtsFixture("transports-by-config");
    const { conn, calls } = fakeCtsConnection([discovery, list]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "list" }),
      MAX_CHARS,
      closedGate(), // proves reuse needs no write authorization at all
    );

    // A4HK900044 is the transport-of-copies request folded into `workbench`
    // by trList (test/transports-parse.test.ts confirms this same fixture
    // puts it there, distinguished only by its own `.kind` field). It must
    // show up in the rendered text without any change to opList's rendering
    // loop having been needed for it.
    expect(res.text).toContain("A4HK900044");
    expect(res.text).toContain("WORKBENCH");
    // `customizing` on this fixture is empty (0 requests), and opList's
    // section loop skips empty categories — so no "CUSTOMIZING" section
    // heading is expected. What DOES prove the render loop is generic
    // (`Object.entries(res)`, not two hardcoded `.workbench`/`.customizing`
    // property reads) is that the header still reports the count for BOTH
    // keys `trList` returned, including the empty one:
    expect(res.text).toMatch(/\bworkbench: 5\b/);
    expect(res.text).toMatch(/\bcustomizing: 0\b/);
    // No fallback warning — a configuration was found and used.
    expect(res.text).not.toMatch(/did not use a saved search configuration/);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations",
    });
    expect(calls[1]).toMatchObject({ method: "GET", url: "/sap/bc/adt/cts/transportrequests" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("creates a search configuration when none exists and a write is already authorized, and says so in a note", async () => {
    const discovery = loadCtsFixture("transport-search-configurations-empty");
    const created = loadCtsFixture("transport-search-configuration-created");
    const list = loadCtsFixture("transports-by-config");
    const { conn, calls } = fakeCtsConnection([discovery, created, list]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "list" }),
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("A4HK900044");
    expect(res.text).toMatch(
      /No saved CTS search configuration existed.*so one was created/s,
    );
    expect(res.text).not.toMatch(/did not use a saved search configuration/);

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations",
    });
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "/sap/bc/adt/cts/transportrequests/searchconfiguration/configurations",
    });
    expect(calls[2]).toMatchObject({ method: "GET", url: "/sap/bc/adt/cts/transportrequests" });
  });

  it("falls back with an honest warning when no configuration exists and write is not authorized, and never creates one itself", async () => {
    const discovery = loadCtsFixture("transport-search-configurations-empty");
    const fixture = loadCtsFixture("user-transports-targets-true-empty");
    const { conn, calls } = fakeCtsConnection([discovery, fixture]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "list", user: "DEVELOPER" }),
      MAX_CHARS,
      closedGate(),
    );

    expect(res.text).toMatch(/did not use a saved search configuration/);
    expect(res.text).toMatch(/does NOT reliably include Modifiable requests/);
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// abap_transport: show
// ---------------------------------------------------------------------------

describe("abap_transport operation: show", () => {
  it("a modifiable request renders TASKS/OBJECTS sections with no 'already released' note", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900117" }),
      MAX_CHARS,
    );

    expect(res.text).not.toMatch(/Already released/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: "/sap/bc/adt/cts/transportrequests/A4HK900117" });
  });

  it("an object recorded under both the request and a task is counted once, not twice", async () => {
    // Fixture ground truth: A4HK900117's tm:all_objects and its task A4HK900118 both carry
    // the SAME R3TR PROG ZMCP_CTS_PROBE entry — one real lock, recorded twice on the wire.
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn } = fakeCtsConnection([fixture]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900117" }),
      MAX_CHARS,
    );

    expect(res.text).toMatch(/^objects: 1$/m);
    const objectRowLines = res.text
      .split("\n")
      .filter((line) => line.includes("ZMCP_CTS_PROBE"));
    expect(objectRowLines).toHaveLength(1);
  });

  it("a released request's note says it can no longer be changed", async () => {
    const fixture = loadCtsFixture("transport-details-released");
    const { conn } = fakeCtsConnection([fixture]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900125" }),
      MAX_CHARS,
    );

    expect(res.text).toContain("Already released — it can no longer be changed.");
  });

  it("rejects a missing transport before any call is made, naming the argument", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(conn, transportInput({ operation: "show" }), MAX_CHARS),
    ).rejects.toMatchObject({ code: "BAD_INPUT", message: expect.stringContaining('"transport"') });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// abap_transport: users
// ---------------------------------------------------------------------------

describe("abap_transport operation: users", () => {
  it("renders the USERS table from the system-users fixture", async () => {
    const fixture = loadCtsFixture("system-users");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransport(conn, transportInput({ operation: "users" }), MAX_CHARS);

    expect(res.text).toContain("USERS");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: "/sap/bc/adt/system/users" });
  });
});

// ---------------------------------------------------------------------------
// abap_transport: check
// ---------------------------------------------------------------------------

describe("abap_transport operation: check", () => {
  it("a $TMP (local) object needs no transport, and the note says so", async () => {
    const fixture = loadCtsFixture("transport-info-tmp");
    const { conn } = fakeCtsConnection([fixture]);

    // A raw ADT URI resolves synchronously (parsed.via === "uri"), so
    // resolveObject makes zero network calls — the single scripted step is
    // consumed entirely by trRequirement's own POST.
    const res = await abapTransport(
      conn,
      transportInput({
        operation: "check",
        object: "/sap/bc/adt/programs/programs/zmcp_dbg_demo",
        package: "$TMP",
      }),
      MAX_CHARS,
    );

    expect(res.text).toContain("Local object: writes need no transport (and must not pass one).");
  });

  it("a transportable package with RECORDING=X warns that the server would SILENTLY FABRICATE a request if no transport is passed", async () => {
    const fixture = loadCtsFixture("transport-info-transportable");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransport(
      conn,
      transportInput({
        operation: "check",
        object: "/sap/bc/adt/programs/programs/zmcp_cts_probe",
        package: "Z_FLIGHT_ADDITIONAL",
      }),
      MAX_CHARS,
    );

    expect(res.text).toMatch(/SILENTLY FABRICATE/);
    expect(res.text).toMatch(/Always pass an explicit transport/);
    // resolveObject made no network call: the only call in the log is
    // trRequirement's own POST to /sap/bc/adt/cts/transportchecks.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "/sap/bc/adt/cts/transportchecks" });
  });
});

// ---------------------------------------------------------------------------
// abap_transport: create
// ---------------------------------------------------------------------------

describe("abap_transport operation: create", () => {
  it("rejects a $-prefixed local package before any call is made — nothing to transport", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "create", package: "$TMP", description: "x" }),
        MAX_CHARS,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a description over 60 characters before any call is made", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(
        conn,
        transportInput({
          operation: "create",
          package: "ZFOO",
          description: "x".repeat(61),
        }),
        MAX_CHARS,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a missing package or description before any call is made, naming the argument", async () => {
    const { conn: c1, calls: calls1 } = fakeCtsConnection([]);
    await expect(
      abapTransport(c1, transportInput({ operation: "create", description: "x" }), MAX_CHARS),
    ).rejects.toMatchObject({ code: "BAD_INPUT", message: expect.stringContaining('"package"') });
    expect(calls1).toHaveLength(0);

    const { conn: c2, calls: calls2 } = fakeCtsConnection([]);
    await expect(
      abapTransport(c2, transportInput({ operation: "create", package: "ZFOO" }), MAX_CHARS),
    ).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringContaining('"description"'),
    });
    expect(calls2).toHaveLength(0);
  });

  it("a package the gate's allowlist refuses is denied before any call is made (SAFETY_DENIED, §10.2)", async () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"] });
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "create", package: "ZOTHER", description: "x" }),
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({ code: "SAFETY_DENIED" });
    expect(calls).toHaveLength(0);
  });

  it("creates a request, reporting the TRKORR and how to use it, with no anchor object given", async () => {
    const fixture = loadCtsFixture("create-transport-response");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "test" }),
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("A4HK900121");
    expect(res.text).toMatch(/Created A4HK900121/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "/sap/bc/adt/cts/transports" });
  });

  it("creates a request with an explicit anchor object, resolved with no network call (raw URI)", async () => {
    const fixture = loadCtsFixture("create-transport-response");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransport(
      conn,
      transportInput({
        operation: "create",
        package: "Z_FLIGHT_ADDITIONAL",
        description: "test",
        object: "/sap/bc/adt/programs/programs/zmcp_cts_probe",
      }),
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("A4HK900121");
    // Only trCreate's own POST — resolveObject on a raw URI is synchronous.
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// abap_transport operation: create — a failed create is not proof nothing happened
// ---------------------------------------------------------------------------
//
// A client-side timeout can lose trCreate's response after the server already created the
// request. `opCreate` reacts by looking for a matching modifiable workbench request before
// letting the original failure through unchanged — see `recoverPossiblyCreated` in
// src/tools/transport.ts.

describe("abap_transport operation: create — recovering from a failed create the server may have already acted on", () => {
  // Real captured 403 whose body does not match either TRANSPORT_GONE (type is
  // "ExceptionResourceNoAuthorization", not "ADT_TM_COMMON_EXCEPTION") or TRANSPORT_LOCKED
  // (no "contains locked objects" text), so `ctsError` classifies it as the generic
  // TRANSPORT_ERROR tail this defect is about. Message: "Task/request A4HK999999 does not
  // exist in system A4H".
  const failedCreate = loadCtsFixture("create-object-error-corrnr-not-found");

  it("(a) a successful create makes no recovery list call at all", async () => {
    const fixture = loadCtsFixture("create-transport-response");
    const { conn, calls } = fakeCtsConnection([fixture]);

    await abapTransport(
      conn,
      transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "test" }),
      MAX_CHARS,
      openGate(),
    );

    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("transportrequests"))).toBe(false);
  });

  it("(b) a matching modifiable workbench request turns the failure into a non-fabricating error naming it", async () => {
    const list = trListWorkbenchBody(
      trListRequest({ trkorr: "A4HK900200", desc: "test" }),
    );
    const { conn, calls } = fakeCtsConnection([failedCreate, list]);

    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "test" }),
        MAX_CHARS,
        openGate(),
      ),
    ).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      message:
        `Creating a transport request for Z_FLIGHT_ADDITIONAL failed, but a modifiable request ` +
        `that matches this create already exists on A4H: A4HK900200. abapsmith cannot prove it ` +
        `came from this call — but a create that fails AFTER the server has already acted looks ` +
        `exactly like this, so do NOT treat this as "nothing happened". The original failure ` +
        `was: Task/request A4HK999999 does not exist in system A4H`,
      hint:
        `Check before creating another request: abap_transport operation="show" ` +
        `transport="A4HK900200" tells you what A4HK900200 actually is, and abap_transport ` +
        `operation="list" shows every request owned by this user. If one of them is the request ` +
        `this call meant to create, pass it as the transport on subsequent writes instead of ` +
        `creating a second one.`,
      details: expect.objectContaining({
        possiblyCreated: ["A4HK900200"],
        operation: "create",
        package: "Z_FLIGHT_ADDITIONAL",
        description: "test",
      }),
    });

    // Exactly one recovery GET, restricted to `targets=false` and no `user` — the fake
    // connection's `cfg` carries no `user`, so the honest move is to skip that filter
    // rather than invent one (see `recoverPossiblyCreated`).
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ method: "GET", url: "/sap/bc/adt/cts/transportrequests" });
    expect(calls[1]!.qs).toEqual({ targets: "false" });
  });

  it("(b cont.) multiple matches are pluralised and all listed", async () => {
    const list = trListWorkbenchBody(
      trListRequest({ trkorr: "A4HK900200", desc: "test" }) +
        trListRequest({ trkorr: "A4HK900201", desc: "test" }),
    );
    const { conn } = fakeCtsConnection([failedCreate, list]);

    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "test" }),
        MAX_CHARS,
        openGate(),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "2 modifiable requests that match this create already exist on A4H: A4HK900200, A4HK900201",
      ),
      details: expect.objectContaining({ possiblyCreated: ["A4HK900200", "A4HK900201"] }),
    });
  });

  it("(c) no candidate found rethrows the original failure completely unchanged", async () => {
    const list = trListWorkbenchBody("");
    const { conn, calls } = fakeCtsConnection([failedCreate, list]);

    let caught: AbapError | undefined;
    try {
      await abapTransport(
        conn,
        transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "test" }),
        MAX_CHARS,
        openGate(),
      );
    } catch (e) {
      caught = e as AbapError;
    }
    expect(caught).toBeInstanceOf(AbapError);
    expect(caught?.code).toBe("TRANSPORT_ERROR");
    expect(caught?.message).toBe("Task/request A4HK999999 does not exist in system A4H");
    // Not the recovery-path shape — this is the untouched original error's own details.
    expect(caught?.details.possiblyCreated).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("(d) the recovery lookup itself throwing still rethrows the original failure unchanged", async () => {
    const listThrows = loadCtsFixture("transport-details-nonexistent-error");
    const { conn, calls } = fakeCtsConnection([failedCreate, listThrows]);

    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "test" }),
        MAX_CHARS,
        openGate(),
      ),
    ).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      message: "Task/request A4HK999999 does not exist in system A4H",
    });
    expect(calls).toHaveLength(2);
  });

  it("(e) a released request and a differently-worded request are not offered as candidates", async () => {
    const list = trListWorkbenchBody(
      // Same description, but released — must not be offered.
      trListRequest({ trkorr: "A4HK900210", desc: "test", status: "R" }) +
        // Modifiable, but a customizing request, not workbench — must not be offered.
        trListRequest({ trkorr: "A4HK900211", desc: "test", type: "W" }) +
        // Modifiable workbench, but a different description — must not be offered.
        trListRequest({ trkorr: "A4HK900212", desc: "unrelated change" }),
    );
    const { conn } = fakeCtsConnection([failedCreate, list]);

    // None of the three qualify, so this collapses to the "no candidate" rethrow.
    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "test" }),
        MAX_CHARS,
        openGate(),
      ),
    ).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      message: "Task/request A4HK999999 does not exist in system A4H",
    });
  });
});

// ---------------------------------------------------------------------------
// abap_transport: addUser
// ---------------------------------------------------------------------------

describe("abap_transport operation: addUser", () => {
  it("reports the task the server volunteers", async () => {
    const { conn, calls } = fakeCtsConnection([addUserBodyWithTask("A4HK900117", "A4HK900118")]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "addUser", transport: "A4HK900117", user: "developer" }),
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("A4HK900118");
    expect(res.text).toMatch(/DEVELOPER now owns task A4HK900118 in A4HK900117/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/sap/bc/adt/cts/transportrequests/A4HK900117/tasks",
    });
  });

  it("when the server reports no task, says so rather than inventing one", async () => {
    const { conn } = fakeCtsConnection([addUserBodyNoTask("A4HK900117")]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "addUser", transport: "A4HK900117", user: "developer" }),
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("(none reported)");
    expect(res.text).toMatch(/The server reported no task for DEVELOPER/);
  });

  it("rejects a missing user before any call is made", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(conn, transportInput({ operation: "addUser", transport: "A4HK900117" }), MAX_CHARS),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("a closed write ceiling refuses addUser before any call is made", async () => {
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "addUser", transport: "A4HK900117", user: "developer" }),
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(calls).toHaveLength(0);
  });

  /**
   * The "plain" write-ceiling refusal's `hint` used to say
   * "Transport changes need ABAP_ALLOW_WRITE=true." unconditionally, which is
   * dead advice once `ABAP_MODE` is set (`src/config.ts`'s "is set but
   * ignored" warning — `ABAP_MODE` is the sole source of truth, and
   * `allowWrite` comes from the mode, not the env var, once a mode is set).
   * Under legacy config (no `abapMode`) the flag really is the lever, so the
   * hint must still name it there.
   */
  it("the write-ceiling hint names ABAP_MODE=edit/admin under ABAP_MODE, and the legacy flag only when ABAP_MODE is unset", async () => {
    const { conn } = fakeCtsConnection([]);

    const legacyGate = new SafetyGate({ readOnly: true, allowPackages: [] });
    const legacyErr = await abapTransport(
      conn,
      transportInput({ operation: "addUser", transport: "A4HK900117", user: "developer" }),
      MAX_CHARS,
      legacyGate,
    ).catch((e: unknown) => e as { hint?: string });
    expect(legacyErr.hint).toContain("ABAP_ALLOW_WRITE=true");
    expect(legacyErr.hint).not.toContain("ABAP_MODE");

    const modeGate = new SafetyGate({ readOnly: true, allowPackages: [], abapMode: "read" });
    const modeErr = await abapTransport(
      conn,
      transportInput({ operation: "addUser", transport: "A4HK900117", user: "developer" }),
      MAX_CHARS,
      modeGate,
    ).catch((e: unknown) => e as { hint?: string });
    expect(modeErr.hint).toContain("ABAP_MODE=edit or admin (it is read)");
    expect(modeErr.hint).not.toContain("ABAP_ALLOW_WRITE");
  });
});

// ---------------------------------------------------------------------------
// abap_transport: setOwner
// ---------------------------------------------------------------------------

describe("abap_transport operation: setOwner", () => {
  it("reassigns the owner and reports it back", async () => {
    const { conn, calls } = fakeCtsConnection([setOwnerOkBody()]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "setOwner", transport: "A4HK900117", user: "developer" }),
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("DEVELOPER");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "PUT",
      url: "/sap/bc/adt/cts/transportrequests/A4HK900117",
    });
  });

  it("rejects a missing user before any call is made", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(conn, transportInput({ operation: "setOwner", transport: "A4HK900117" }), MAX_CHARS),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("a closed write ceiling refuses setOwner before any call is made", async () => {
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "setOwner", transport: "A4HK900117", user: "developer" }),
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// abap_transport: delete
// ---------------------------------------------------------------------------

describe("abap_transport operation: delete", () => {
  it("without confirm, refuses as a dry run before any call is made, naming the exact confirm string needed", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(conn, transportInput({ operation: "delete", transport: "A4HK900117" }), MAX_CHARS),
    ).rejects.toMatchObject({ code: "BAD_INPUT", message: expect.stringContaining("A4HK900117") });
    expect(calls).toHaveLength(0);
  });

  it("a mismatched confirm is BAD_INPUT before any call is made", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "delete", transport: "A4HK900117", confirm: "A4HK900118" }),
        MAX_CHARS,
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("a closed write ceiling refuses delete before any call is made, even with a matching confirm", async () => {
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "delete", transport: "A4HK900117", confirm: "A4HK900117" }),
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(calls).toHaveLength(0);
  });

  it("allowWrite alone (no allowTransportDelete) refuses delete before any call is made — mirrors the release-ceiling test just above", async () => {
    // Write is on and the package allowlist is wide open — the same shape
    // as `ABAP_MODE=edit` resolves to — but the admin-mode-only
    // allowTransportDelete ceiling is off. Before this ceiling existed, this
    // exact gate shape (readOnly: false) let a transport delete straight
    // through with no admin-only distinction at all — the gap this closes.
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"] });
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "delete", transport: "A4HK900117", confirm: "A4HK900117" }),
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(calls).toHaveLength(0);
  });

  it("an admin-mode-shaped gate (allowTransportDelete: true) still allows delete — regression check", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-ok");
    const after = loadCtsFixture("transport-details-nonexistent-error");
    const { conn, calls } = fakeCtsConnection([before, del, after]);
    const adminGate = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowTransportDelete: true,
    });

    const res = await abapTransport(
      conn,
      transportInput({ operation: "delete", transport: "A4HK900117", confirm: "A4HK900117" }),
      MAX_CHARS,
      adminGate,
    );

    expect(res.text).toContain("DELETED — confirmed gone");
    expect(calls).toHaveLength(3);
  });

  it("a request that existed and is confirmed gone renders DELETED, not a bare success claim", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-ok");
    const after = loadCtsFixture("transport-details-nonexistent-error");
    const { conn, calls } = fakeCtsConnection([before, del, after]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "delete", transport: "A4HK900117", confirm: "A4HK900117" }),
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("DELETED — confirmed gone");
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE", "GET"]);
  });

  it("a request that never existed renders NOT FOUND, never DELETED — the byte-identical empty 200 is not evidence of a deletion", async () => {
    const before = loadCtsFixture("transport-details-nonexistent-error");
    const del = loadCtsFixture("transport-delete-nonexistent-noop");
    const after = loadCtsFixture("transport-details-nonexistent-error");
    const { conn, calls } = fakeCtsConnection([before, del, after]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "delete", transport: "A4HK999999", confirm: "A4HK999999" }),
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("NO SUCH REQUEST — nothing was deleted");
    expect(res.text).not.toContain("DELETED — confirmed gone");
    expect(res.text).toMatch(/byte-identical empty 200/);
    expect(res.text).toMatch(/not evidence of a deletion.*'not found', not a success/s);
    expect(calls).toHaveLength(3);
  });

  describe("deleting a TASK number no longer renders the parent's continued existence as a false negative (D-23, trDelete side)", () => {
    // No fixture exists for deleting a task number — every captured
    // transport-delete-*.meta.json targets a request number
    // (A4HK900117/119/121). What CTS actually returns from a GET of a
    // deleted task's number (a straight TRANSPORT_GONE 400, or the parent
    // alone with the task no longer listed) has never been captured either.
    // The "after" body below is built from the REAL sibling-shape fixture's
    // own bytes (`transport-details-task-resolves-to-parent.xml`, truncated
    // at the exact byte where its sibling `<tm:task>` begins, then closed) to
    // model the second of those two possibilities — the one the old,
    // parent-existence-based code got wrong. It is marked SYNTHETIC because
    // that truncation itself was never observed on the wire.
    function parentOnlyAfterTaskDeleteSynthetic(): CtsScriptStep {
      const full = loadCtsFixture("transport-details-task-resolves-to-parent").body;
      const cut = full.indexOf('<tm:task tm:number="A4HK900132"');
      if (cut < 0) {
        throw new Error("fixture shape changed: sibling <tm:task> marker not found");
      }
      return { status: 200, body: full.slice(0, cut) + "</tm:root>" };
    }

    it("SYNTHETIC: a deleted task whose parent is still readable (and no longer lists the task) renders DELETED, not NOT DELETED", async () => {
      const before = loadCtsFixture("transport-details-task-resolves-to-parent");
      const del: CtsScriptStep = { status: 200, body: "" };
      const after = parentOnlyAfterTaskDeleteSynthetic();
      const { conn, calls } = fakeCtsConnection([before, del, after]);

      const res = await abapTransport(
        conn,
        transportInput({ operation: "delete", transport: "A4HK900132", confirm: "A4HK900132" }),
        MAX_CHARS,
        openGate(),
      );

      // The old bug: `trDelete` judged `after.request` (the parent,
      // A4HK900131, still very much readable) rather than the task itself,
      // so a successfully deleted task rendered "NOT DELETED — the request
      // still exists". The fix judges the NAMED entity (`probe`'s `own`):
      // the task is no longer among the parent's `.tasks`, so it is gone.
      expect(res.text).toContain("DELETED — confirmed gone");
      expect(res.text).not.toContain("NOT DELETED");
      expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE", "GET"]);
      expect(calls[1]?.url).toBe("/sap/bc/adt/cts/transportrequests/A4HK900132");
    });

    it("SYNTHETIC: a delete that did NOT take — the task is still listed among the parent's tasks — renders NOT DELETED and states the TASK's own status, not the parent's", async () => {
      // Same "before"/"delete" as above, but the re-read replays the
      // unmodified sibling fixture verbatim: the task is still there,
      // released, exactly as before the call.
      const before = loadCtsFixture("transport-details-task-resolves-to-parent");
      const del: CtsScriptStep = { status: 200, body: "" };
      const after = loadCtsFixture("transport-details-task-resolves-to-parent");
      const { conn } = fakeCtsConnection([before, del, after]);

      const res = await abapTransport(
        conn,
        transportInput({ operation: "delete", transport: "A4HK900132", confirm: "A4HK900132" }),
        MAX_CHARS,
        openGate(),
      );

      expect(res.text).toContain("NOT DELETED — the request still exists");
      // This is the honesty fix in `deleteNotes`: `res.remaining` is the
      // PARENT (A4HK900131, "Modifiable"), but the note must describe the
      // NAMED task's own status ("Released"), not the parent's — otherwise a
      // released task reads back as "Modifiable", which is simply false.
      expect(res.text).toMatch(/It is still Released \(tm:status=R\)\./);
      expect(res.text).not.toMatch(/It is still Modifiable/);
    });
  });
});

// ---------------------------------------------------------------------------
// abap_transport delete: TRANSPORT_LOCKED diagnosis
//
// abapsmith can now remove one locked entry (operation "removeObject"), but
// there is still no way to unlock one without removing it. The 400 fixture
// below names the CHILD TASK A4HK900118, not the A4HK900117 that was
// actually passed.
// ---------------------------------------------------------------------------

describe("abap_transport operation: delete — locked-entry diagnosis", () => {
  async function caughtDelete(steps: CtsScriptStep[], searchObject?: FakeSearchObject) {
    const { conn, calls } = fakeCtsConnection(steps, searchObject);
    const err = await abapTransport(
      conn,
      transportInput({ operation: "delete", transport: "A4HK900117", confirm: "A4HK900117" }),
      MAX_CHARS,
      openGate(),
    ).catch((e: unknown) => e as { code?: string; message?: string; hint?: string; details?: Record<string, unknown> });
    return { err, calls };
  }

  /** A synthetic TRANSPORT_LOCKED 400, same shape as transport-delete-error-locked-objects.xml but with a caller-chosen message — for asserting the discrepancy check itself, not the fixture's fixed wording. */
  function lockedDeleteError(message: string): CtsScriptStep {
    const body =
      `<?xml version="1.0" encoding="utf-8"?><exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` +
      `<namespace id="com.sap.adt.tm"/><type id="ADT_TM_COMMON_EXCEPTION"/>` +
      `<message lang="EN">${message}</message><localizedMessage lang="EN">${message}</localizedMessage><properties/></exc:exception>`;
    return {
      meta: {
        method: "DELETE",
        url: "/sap/bc/adt/cts/transportrequests/A4HK900117",
        qs: null,
        requestHeaders: {},
        requestBody: null,
        status: 400,
        statusText: "Bad Request",
        responseHeaders: { "content-type": "application/xml" },
        threw: true,
        bodyFile: "",
        bodyBytes: body.length,
      },
      body,
    };
  }

  it("a locked entry whose object no longer exists: hint calls it a leftover, never says remove/delete the task", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-error-locked-objects");
    const reread = loadCtsFixture("transport-details-with-objects");
    const searchObject = vi.fn(async () => []); // nothing found — the entry outlived its object
    const { err, calls } = await caughtDelete([before, del, reread], searchObject);

    expect(err.code).toBe("TRANSPORT_LOCKED");
    expect(err.hint).toMatch(/leftover/i);
    expect(err.hint).not.toMatch(/remove the locked objects/i);
    expect(err.hint).not.toMatch(/delete the owning task first/i);
    expect(err.hint).not.toMatch(/cannot remove or unlock an entry/i);
    expect(err.hint).toContain('abap_transport operation "removeObject"');
    expect(err.details?.entries).toEqual([
      expect.objectContaining({ name: "ZMCP_CTS_PROBE", locked: true, object: "absent" }),
    ]);
    expect(calls).toHaveLength(3);
  });

  it("a locked entry whose object still exists: hint names it, does not claim it's gone", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-error-locked-objects");
    const reread = loadCtsFixture("transport-details-with-objects");
    const searchObject = vi.fn(async () => [{ "adtcore:name": "ZMCP_CTS_PROBE" }]);
    const { err } = await caughtDelete([before, del, reread], searchObject);

    expect(err.code).toBe("TRANSPORT_LOCKED");
    expect(err.hint).toContain("ZMCP_CTS_PROBE");
    expect(err.hint).not.toMatch(/leftover|is gone/i);
    expect(err.details?.entries).toEqual([
      expect.objectContaining({ name: "ZMCP_CTS_PROBE", locked: true, object: "present" }),
    ]);
  });

  it("no adt stub available: the probe cannot look, entries render unknown, hint refuses to claim gone", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-error-locked-objects");
    const reread = loadCtsFixture("transport-details-with-objects");
    const { err } = await caughtDelete([before, del, reread]); // no searchObject stub passed

    expect(err.code).toBe("TRANSPORT_LOCKED");
    expect(err.hint).toMatch(/could not settle/i);
    expect(err.hint).not.toMatch(/leftover|is gone/i);
    expect(err.details?.entries).toEqual([
      expect.objectContaining({ name: "ZMCP_CTS_PROBE", locked: true, object: "unknown" }),
    ]);
  });

  it("code stays TRANSPORT_LOCKED and the message stays SAP's verbatim text", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-error-locked-objects");
    const reread = loadCtsFixture("transport-details-with-objects");
    const { err } = await caughtDelete([before, del, reread]);

    expect(err.code).toBe("TRANSPORT_LOCKED");
    expect(err.message).toBe(
      "Request/task A4HK900118 cannot be deleted because it contains locked objects",
    );
  });

  it("SAP's message naming a task of the passed request states that relationship and names both numbers", async () => {
    const before = loadCtsFixture("transport-details-with-objects"); // A4HK900117, task A4HK900118
    const del = loadCtsFixture("transport-delete-error-locked-objects"); // message names A4HK900118
    const reread = loadCtsFixture("transport-details-with-objects");
    const { err } = await caughtDelete([before, del, reread]);

    expect(err.code).toBe("TRANSPORT_LOCKED");
    expect(err.hint).toMatch(/SAP's message names A4HK900118, a task of A4HK900117/);
    expect(err.hint).toContain("A4HK900117 is the number to act on");
  });

  it("SAP's message naming only the passed number adds no discrepancy warning", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = lockedDeleteError(
      "Request/task A4HK900117 cannot be deleted because it contains locked objects",
    );
    const reread = loadCtsFixture("transport-details-with-objects");
    const { err } = await caughtDelete([before, del, reread]);

    expect(err.code).toBe("TRANSPORT_LOCKED");
    expect(err.hint).not.toMatch(/SAP's message names/);
  });

  it("a non-locked delete failure passes through untouched — no extra GET, code/hint unchanged", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const del = loadCtsFixture("transport-delete-error-already-released");
    const { conn, calls } = fakeCtsConnection([before, del]);

    const err = await abapTransport(
      conn,
      transportInput({ operation: "delete", transport: "A4HK900121", confirm: "A4HK900121" }),
      MAX_CHARS,
      openGate(),
    ).catch((e: unknown) => e as { code?: string; message?: string });

    expect(err.code).toBe("TRANSPORT_ERROR");
    expect(err.message).toContain("already released");
    // Only the before-GET and the failing DELETE — diagnoseLockedDelete never fires.
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// abap_transport_release: confirm gate (dry run vs armed)
// ---------------------------------------------------------------------------

describe("abap_transport_release: the confirm gate", () => {
  it("a mismatched confirm is BAD_INPUT and makes no call at all — checked before any connection use", async () => {
    const { conn, calls } = fakeCtsConnection([]);
    await expect(
      abapTransportRelease(
        conn,
        { transport: "A4HK900117", confirm: "A4HK900118" },
        MAX_CHARS,
        openGate(),
      ),
    ).rejects.toMatchObject({ code: "BAD_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("absent confirm is a dry run: it reads the request and reports whether release is permitted, but NEVER calls release — no POST is ever issued", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransportRelease(conn, { transport: "A4HK900117" }, MAX_CHARS, openGate());

    expect(res.text).toMatch(/DRY RUN — nothing was released/);
    expect(res.text).toMatch(/releasePermitted: yes/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("a dry run against a closed ceiling still reads, but reports release as refused and explains why — still never calls release", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransportRelease: false });
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransportRelease(conn, { transport: "A4HK900117" }, MAX_CHARS, gate);

    expect(res.text).toMatch(/releasePermitted: no/);
    expect(res.text).toMatch(/Release is refused by the server's policy/);
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `releasePermitted` and CTS's own TR/732 precondition are two
// different questions. Live evidence: an open task holding 0 objects
// released cleanly (the TR/732 note over-warned, but `releasePermitted: yes`
// was right); an open task holding 1 object aborted the release with TR/732
// (the note was right). `releasePermitted` keeps meaning "does this server's
// policy permit the call" — existing callers already branch on it. The new,
// separate `releaseBlockedBy` header field answers CTS's question, and is
// present only when a task actually blocks (modifiable AND holding objects).
// ---------------------------------------------------------------------------

describe("abap_transport_release dry run: releasePermitted and releaseBlockedBy answer different questions", () => {
  it("an open task holding 1 object, ceiling allowed: releasePermitted yes, releaseBlockedBy names it, and the TR/732 note is present", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransportRelease(conn, { transport: "A4HK900117" }, MAX_CHARS, openGate());

    expect(res.text).toMatch(/^releasePermitted: yes$/m);
    expect(res.text).toMatch(/^releaseBlockedBy: A4HK900118$/m);
    expect(res.text).toMatch(
      /1 task\(s\) under A4HK900117 are still modifiable AND hold objects \(A4HK900118\)/,
    );
    expect(res.text).toMatch(/aborts the release with TR\/732/);
    expect(res.text).toMatch(/Release A4HK900118 first, then A4HK900117/);
    // The 0-object note is a different case entirely — must not also fire here.
    expect(res.text).not.toMatch(/hold no objects/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("an open task holding 1 object, ceiling denied: releaseBlockedBy still names it — CTS's precondition does not depend on this server's policy", async () => {
    const fixture = loadCtsFixture("transport-details-with-objects");
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransportRelease: false });
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransportRelease(conn, { transport: "A4HK900117" }, MAX_CHARS, gate);

    expect(res.text).toMatch(/^releasePermitted: no$/m);
    expect(res.text).toMatch(/^releaseBlockedBy: A4HK900118$/m);
    expect(res.text).toMatch(/Release is refused by the server's policy/);
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("an open task holding 0 objects, ceiling allowed: releasePermitted yes, NO releaseBlockedBy, the empty-task note names it, and there is no TR/732 blocker claim", async () => {
    const fixture = loadCtsFixture("transport-details-empty-request");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransportRelease(conn, { transport: "A4HK900121" }, MAX_CHARS, openGate());

    expect(res.text).toMatch(/^releasePermitted: yes$/m);
    expect(res.text).not.toMatch(/^releaseBlockedBy:/m);
    expect(res.text).toMatch(
      /1 task\(s\) are still modifiable but hold no objects \(A4HK900122\)/,
    );
    expect(res.text).not.toMatch(/aborts the release with TR\/732/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("an open task holding 0 objects, ceiling denied: still no releaseBlockedBy, still the empty-task note", async () => {
    const fixture = loadCtsFixture("transport-details-empty-request");
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransportRelease: false });
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransportRelease(conn, { transport: "A4HK900121" }, MAX_CHARS, gate);

    expect(res.text).toMatch(/^releasePermitted: no$/m);
    expect(res.text).not.toMatch(/^releaseBlockedBy:/m);
    expect(res.text).toMatch(
      /1 task\(s\) are still modifiable but hold no objects \(A4HK900122\)/,
    );
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("regression: releasePermitted: yes never sits beside a TR/732 abort claim unless releaseBlockedBy is also present", async () => {
    // Structural check rather than a fixed-wording one, so it stays true even
    // if the note's phrasing changes again: the presence of the TR/732 claim
    // and the presence of releaseBlockedBy must always agree.
    for (const { name, trkorr } of [
      { name: "transport-details-with-objects", trkorr: "A4HK900117" },
      { name: "transport-details-empty-request", trkorr: "A4HK900121" },
    ]) {
      const fixture = loadCtsFixture(name);
      const { conn } = fakeCtsConnection([fixture]);

      const res = await abapTransportRelease(conn, { transport: trkorr }, MAX_CHARS, openGate());

      expect(res.text.includes("aborts the release with TR/732")).toBe(
        /^releaseBlockedBy:/m.test(res.text),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// abap_transport_release: the ceiling (§10.3) — ABAP_ALLOW_WRITE alone is not
// enough; ABAP_ALLOW_TRANSPORT_RELEASE is required on top.
// ---------------------------------------------------------------------------

describe("abap_transport_release: the release ceiling is honoured", () => {
  it("write-off (readOnly) refuses an armed release before any network call — zero calls, never a POST", async () => {
    // `abapTransportRelease`'s armed path now checks the ceiling BEFORE the
    // pre-read GET: a closed ceiling must never touch the appliance to find
    // out it is closed. So a closed ceiling costs zero calls — not even the
    // read that would otherwise check for already-released.
    const gate = new SafetyGate({ readOnly: true, allowPackages: [], allowTransportRelease: true });
    const { conn, calls } = fakeCtsConnection([]);

    await expect(
      abapTransportRelease(conn, { transport: "A4HK900117", confirm: "A4HK900117" }, MAX_CHARS, gate),
    ).rejects.toMatchObject({ code: "READ_ONLY" });

    expect(calls).toHaveLength(0);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("ABAP_ALLOW_WRITE=true alone does NOT enable release — the release-specific ceiling still refuses before any network call, and no release POST is issued", async () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransportRelease: false });
    const { conn, calls } = fakeCtsConnection([]);

    await expect(
      abapTransportRelease(conn, { transport: "A4HK900117", confirm: "A4HK900117" }, MAX_CHARS, gate),
    ).rejects.toMatchObject({ code: "READ_ONLY", message: expect.stringContaining("ABAP_ALLOW_TRANSPORT_RELEASE") });

    expect(calls).toHaveLength(0);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  /**
   * The release-ceiling refusal's `hint` used to name
   * `ABAP_ALLOW_TRANSPORT_RELEASE=true` unconditionally, even though
   * `allowTransportRelease` is `isAdmin`-only under `ABAP_MODE`
   * (`src/mode.ts`) and `ABAP_ALLOW_TRANSPORT_RELEASE` is one of the six
   * legacy vars `ABAP_MODE` fully overrides (`src/config.ts`'s "is set but
   * ignored" warning) — a hint an `ABAP_MODE=edit` operator could act on and
   * have nothing happen. Under legacy config (no `abapMode`) the flag really
   * is the lever, so the hint must still name it there.
   */
  it("the release-ceiling hint names ABAP_MODE=admin under ABAP_MODE, and the legacy flag only when ABAP_MODE is unset", async () => {
    const { conn } = fakeCtsConnection([]);

    const legacyGate = new SafetyGate({ readOnly: false, allowPackages: ["*"], allowTransportRelease: false });
    const legacyErr = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      legacyGate,
    ).catch((e: unknown) => e as { hint?: string });
    // The actionable instruction — "Releasing needs X" — must name the flag
    // that is actually live for THIS regime; the trailing "not implied by
    // ordinary write access" disclaimer legitimately mentions ABAP_MODE=edit
    // as a standing structural fact true in every regime, so it is not
    // asserted away here.
    expect(legacyErr.hint).toContain("Releasing needs ABAP_ALLOW_TRANSPORT_RELEASE=true.");

    const modeGate = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowTransportRelease: false,
      abapMode: "edit",
    });
    const modeErr = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      modeGate,
    ).catch((e: unknown) => e as { hint?: string });
    expect(modeErr.hint).toContain("ABAP_MODE=admin (it is edit)");
    expect(modeErr.hint).not.toContain("ABAP_ALLOW_TRANSPORT_RELEASE");
  });

  it("both flags together permit an armed release to proceed to the POST", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const release = loadCtsFixture("transport-release-success");
    const after = loadCtsFixture("transport-details-released");
    const { conn, calls } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toMatch(/RELEASED/);
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// abap_transport_release: already-released is not miscredited to this call.
// ---------------------------------------------------------------------------

describe("abap_transport_release: an already-released request is not miscredited", () => {
  it("with an open ceiling, the pre-read alone is enough to report ALREADY RELEASED — no release call is made", async () => {
    const alreadyReleased = loadCtsFixture("transport-details-released");
    const { conn, calls } = fakeCtsConnection([alreadyReleased]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900125", confirm: "A4HK900125" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("ALREADY RELEASED — this call released nothing");
    expect(res.text).toMatch(/No release was attempted/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });

  it("a closed ceiling now refuses an armed release before the pre-read — even a transport that would turn out to already be released never gets that far", async () => {
    // Before this fix, the pre-read GET ran before the ceiling check, so an
    // already-released transport short-circuited past a closed ceiling with
    // no refusal at all (see the two tests above: that GET is what this file
    // used to accept as the unavoidable cost of an armed call). Checking the
    // ceiling before ANY network call — the fix for the release path sending
    // a pre-read GET before refusing — necessarily also closes this path:
    // the ceiling now refuses before it can ever learn the transport was
    // already released.
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });
    const { conn, calls } = fakeCtsConnection([]);

    await expect(
      abapTransportRelease(
        conn,
        { transport: "A4HK900125", confirm: "A4HK900125" },
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// abap_transport_release: the four outcomes render distinguishably.
// ---------------------------------------------------------------------------

describe("abap_transport_release: the four release outcomes render distinguishably", () => {
  it("outcome released: reported and confirmed by the re-read", async () => {
    const before = loadCtsFixture("transport-details-with-objects"); // A4HK900117, modifiable
    const release = loadCtsFixture("transport-release-success"); // A4HK900122 envelope, reportedReleased true
    const after = loadCtsFixture("transport-details-released"); // A4HK900125, status released
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("RELEASED — reported and confirmed");
    expect(res.text).toMatch(/outcome: released\b/);
  });

  it("outcome released-despite-abort: the envelope's abort is contradicted by the re-read, and the operator is told the request IS released — the centerpiece lying-envelope case", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const release = loadCtsFixture("transport-release-abort-pre-export-yet-released"); // PU/238
    const after = loadCtsFixture("transport-details-released");
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("RELEASED — despite an abort report");
    expect(res.text).toMatch(/outcome: released-despite-abort/);
    // The exact claim the task cites as the centerpiece: tell the operator
    // the request IS released, not that it merely "might be".
    expect(res.text).toMatch(/the request IS released/);
    expect(res.text).toMatch(/lying-envelope case/);
  });

  it("outcome aborted: a genuine abort with the re-read confirming the request is still modifiable", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const release = loadCtsFixture("transport-release-abort-inactive-object"); // EU/829
    const after = loadCtsFixture("transport-details-empty-request"); // still modifiable
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("NOT RELEASED — the release was aborted");
    expect(res.text).toMatch(/outcome: aborted\b/);
  });

  it("outcome unknown: the re-read itself fails, so the operator is told this is neither success nor failure and must re-check rather than guess", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const release = loadCtsFixture("transport-release-abort-already-released"); // TR/768
    // Reused purely for its shape: a genuine, non-"gone" thrown failure on
    // the re-read (same reuse test/transports-verify.test.ts makes for its
    // own "unknown" case).
    const rereadFails = loadCtsFixture("transport-delete-error-locked-objects");
    const { conn } = fakeCtsConnection([before, release, rereadFails]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("COULD NOT VERIFY — outcome unknown");
    expect(res.text).toMatch(/outcome: unknown\b/);
    expect(res.text).toMatch(
      /neither\s+success\s+nor\s+failure: do not report the request as released, and do not report it as unreleased/,
    );
  });
});

// ---------------------------------------------------------------------------
// D-15: an unverified release must never be rendered as a confirmed one.
//
// `trRelease` re-reads unconditionally, but when the envelope claimed success
// AND the re-read throws it deliberately keeps `outcome: "released"` (the
// envelope's claim) with `verified: false` — see src/adt/transports.ts's
// "A failed re-read must not downgrade a genuine success to unknown". That
// combination is the one this tool used to render as
// "RELEASED — reported and confirmed", i.e. as a confirmation it never made.
// ---------------------------------------------------------------------------

describe("abap_transport_release: a reported-but-unverified release is not rendered as confirmed (D-15)", () => {
  it("outcome released with a FAILED re-read renders NOT CONFIRMED, never 'reported and confirmed', and never claims a re-read confirmed anything", async () => {
    const before = loadCtsFixture("transport-details-with-objects"); // A4HK900117, modifiable
    const release = loadCtsFixture("transport-release-success"); // chkrun:status="released"
    // Reused for its shape only: a genuine, non-"gone" thrown failure on the
    // re-read (the same reuse the "outcome unknown" test above makes).
    const rereadFails = loadCtsFixture("transport-delete-error-locked-objects");
    const { conn } = fakeCtsConnection([before, release, rereadFails]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );
    expect(res.text).toContain("RELEASED (REPORTED) — NOT CONFIRMED");
    expect(res.text).not.toContain("RELEASED — reported and confirmed");
    // The specific false sentence: there was no confirming re-read, and with
    // `actualStatus` undefined the old wording rendered as "...confirms it is
    // now unknown", which is worse than saying nothing.
    expect(res.text).not.toMatch(/re-read of the request confirms/);
    expect(res.text).toMatch(/did NOT observe the request in a released state/);
    // The adt layer's own classification is reported unchanged — this fix is
    // about what the tool CLAIMS, not about reclassifying the outcome.
    expect(res.text).toMatch(/outcome: released\b/);
    expect(res.text).toMatch(/verified: false/);
    expect(res.text).toMatch(/confirmedByReRead: false/);
    // "not re-read" was false too: the re-read ran and failed.
    expect(res.text).toMatch(/statusAfter: re-read failed/);
    expect(res.text).not.toMatch(/statusAfter: not re-read/);
    // An unconfirmed release must not carry the downstream consequences of a
    // confirmed one.
    expect(res.text).not.toMatch(/is now frozen/);
  });

  it("a genuinely confirmed release still says so, and marks itself confirmed", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const release = loadCtsFixture("transport-release-success");
    const after = loadCtsFixture("transport-details-released");
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("RELEASED — reported and confirmed");
    expect(res.text).toMatch(/confirmedByReRead: true/);
    expect(res.text).toMatch(/is now frozen/);
  });
});

// ---------------------------------------------------------------------------
// D-23: a GET of a TASK number answers about the task's PARENT request.
//
// Live capture `transport-details-task-resolves-to-parent`:
//   GET /sap/bc/adt/cts/transportrequests/A4HK900132
//   -> <tm:request tm:number="A4HK900131" tm:status="D">
//        <tm:task tm:number="A4HK900132" tm:status="R"/>
// So `trShow("A4HK900132")` returns a TrRequest whose trkorr is A4HK900131.
// The caller named one number and every field they are shown describes a
// different one. That substitution must be visible.
//
// A re-read that answers about the parent is not automatically a dead
// end. The parent's task list can carry the asked task's own row, and that
// row — when it reads `released` or `modifiable`, the two statuses this code
// recognises as decisive — settles the question `releaseVerdict` otherwise
// falls back to "COULD NOT VERIFY" on. The tests below exercise every shape
// that row can take.
// ---------------------------------------------------------------------------

/**
 * SYNTHETIC: the real `transport-details-task-resolves-to-parent`
 * fixture with ONLY the sibling task's own `tm:status`/`tm:status_text`
 * flipped from Released back to Modifiable — the parent's own status
 * ("D") is untouched. This exact combination (task still open, parent still
 * open, sibling shape) was never captured live, because the only captured
 * task fixture has the task already released, so this is built once here and
 * reused by every test below that needs "task still open" as either the
 * pre-read or the post-release re-read's shape.
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
  expect(stillOpen).not.toBe(real.body); // the substitution above actually did something
  return stillOpen;
}

/**
 * SYNTHETIC: the real fixture with the sibling `<tm:task
 * tm:number="A4HK900132">...</tm:task>` element deleted outright, so the
 * parent's post-release re-read carries 0 tasks and there is no row to read
 * at all — the case {@link substitutedTaskRow} (src/tools/transport.ts)
 * returns `undefined` for. Never captured live: the real fixture always
 * lists the task.
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
  expect(noTask).not.toBe(real.body); // the deletion above actually did something
  expect(noTask).not.toContain(taskMarker); // the task's own element is gone
  return noTask;
}

describe("a task number silently resolving to its parent request is surfaced (D-23)", () => {
  it("the fixture really does substitute, AND the sibling task is recovered — the task element is a sibling of tm:request, and trShow now merges it in", async () => {
    // This is the premise every assertion below rests on, so it is asserted
    // rather than assumed. On a request GET the tasks nest INSIDE tm:request
    // (see the other transport-details-* fixtures, whose TASKS section this
    // file renders); on a task GET the server emits <tm:request> for the
    // parent and the task as its SIBLING under <tm:root>. This byte shape is
    // real and unchanged by the parser fix — what changed is that `trShow`
    // now merges the sibling into `.tasks` instead of silently dropping it.
    const fixture = loadCtsFixture("transport-details-task-resolves-to-parent");
    expect(fixture.body).toContain('<tm:request tm:number="A4HK900131"');
    expect(fixture.body).toContain('</tm:request><tm:task tm:number="A4HK900132"');

    const { conn } = fakeCtsConnection([fixture]);
    const res = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900132" }),
      MAX_CHARS,
    );
    // Substitution itself is unchanged: the top-level answer is still about
    // the parent.
    expect(res.text).toMatch(/^transport: A4HK900131$/m);
    // The fix: the named task is no longer dropped from the parsed result.
    expect(res.text).toMatch(/^tasks: 1$/m);
  });

  it("operation show: the caller named A4HK900132 and is told, in the header and in a note, that the answer is about A4HK900131 — and now also the task's own real status", async () => {
    const fixture = loadCtsFixture("transport-details-task-resolves-to-parent");
    const { conn } = fakeCtsConnection([fixture]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900132" }),
      MAX_CHARS,
    );
    expect(res.text).toMatch(/requested: A4HK900132/);
    expect(res.text).toMatch(/answeredAbout: A4HK900131/);
    expect(res.text).toMatch(
      /SUBSTITUTION — you named A4HK900132, the server answered about A4HK900131/,
    );
    // The parser fix recovers the task's own status: this call learned
    // something real about A4HK900132, and says so instead of "not known".
    expect(res.text).toMatch(/requestedStatus: Released \(tm:status=R\)/);
    expect(res.text).toMatch(/A4HK900132 is listed among A4HK900131's tasks and reads Released/);
    expect(res.text).not.toMatch(/not known/);
    expect(res.text).not.toMatch(/This call learned nothing about A4HK900132's own state/);
    // opShow's own plain-English gloss for a substituted, already-released task.
    expect(res.text).toMatch(/A4HK900132 is itself already released — it can no longer be changed\./);
  });

  it("a dry run on an already-released task now reports it as already released — and still never POSTs", async () => {
    const fixture = loadCtsFixture("transport-details-task-resolves-to-parent");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransportRelease(conn, { transport: "A4HK900132" }, MAX_CHARS, openGate());

    expect(res.text).toMatch(/DRY RUN — nothing was released/);
    expect(res.text).toMatch(/SUBSTITUTION — you named A4HK900132/);
    // The fix: the task's own status is now recoverable, so the dry run says
    // it plainly instead of "not known".
    expect(res.text).toMatch(/requestedStatus: Released \(tm:status=R\)/);
    expect(res.text).toMatch(
      /A4HK900132 is itself already released — reads Released \(tm:status=R\)\. There is nothing left to do\./,
    );
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("an armed release of an already-released task short-circuits BEFORE the POST — the real fixture's task is already Released, so this call releases nothing", async () => {
    // The only captured task fixture happens to carry an already-released
    // task (A4HK900132 reads "R" while its parent A4HK900131 is still "D").
    // That is now caught by the already-released-TASK short-circuit added
    // alongside the parser fix, ahead of the POST — this replaces the old
    // test that asserted a POST went out, which the fix correctly prevents
    // for exactly this fixture. Coverage for the "POST reaches the task, the
    // re-read redirects to the parent" case (a task that is NOT yet
    // released) is preserved in the next, SYNTHETIC test below.
    const fixture = loadCtsFixture("transport-details-task-resolves-to-parent");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(res.text).toMatch(/ALREADY RELEASED — this call released nothing/);
    expect(res.text).toMatch(
      /A4HK900132 is itself already released — reads Released \(tm:status=R\)\. No release was attempted\./,
    );
    expect(res.text).toMatch(/SUBSTITUTION — you named A4HK900132/);
  });

  it("an armed release of a task that is NOT yet released reaches the POST aimed at the task itself, and the task's own row in the parent's post-release re-read PROVES the release — RELEASED, not COULD NOT VERIFY", async () => {
    // The real fixture's task is already released, which the short-circuit
    // above correctly intercepts before any POST — so it cannot exercise the
    // POST/re-read path at all. `taskStillOpenBody()` is the one byte-level
    // difference needed to get past the short-circuit: the SAME real fixture
    // with ONLY the task's own tm:status/tm:status_text flipped from
    // Released back to Modifiable (the parent's — already "D" — is
    // untouched). This exact combination (task still open, parent still
    // open, sibling shape) was never captured live, hence SYNTHETIC.
    //
    // CTS resolves the post-release GET of a task number to its PARENT
    // request, so `res.actualStatus` describes the parent (still "D") and on
    // its own proves nothing about the task. But the parent's re-read
    // carries the task's OWN row in its task list, and that row (now "R",
    // Released) settles the question this call actually asked — see
    // `substitutedTaskRow` and the doc comment at
    // src/tools/transport.ts:1490-1500 for the two failure modes this must
    // not reintroduce (claiming a confirmation that never returned; blaming
    // a re-read that actually succeeded).
    const before: CtsScriptStep = { status: 200, body: taskStillOpenBody() };
    const release = loadCtsFixture("transport-release-success"); // envelope claims released
    const after = loadCtsFixture("transport-details-task-resolves-to-parent"); // parent again (real, unmodified) — A4HK900132 reads R
    const { conn, calls } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
    );

    // The release itself is aimed at the number the caller named — it is the
    // READS either side of it that get substituted.
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(calls[1]?.url).toBe(
      "/sap/bc/adt/cts/transportrequests/A4HK900132/newreleasejobs",
    );
    expect(res.text).toMatch(/SUBSTITUTION — you named A4HK900132/);
    expect(res.text).toContain("RELEASED — the task's own row in the parent confirms it");
    expect(res.text).toMatch(/^confirmedByReRead: true$/m);
    expect(res.text).toMatch(/^requestedStatusAfter: Released \(tm:status=R\)$/m);
    expect(res.text).toMatch(/is now frozen/);
    expect(res.text).not.toContain("COULD NOT VERIFY");
  });

  it("fallback: the task is absent from the parent's post-release task list — COULD NOT VERIFY survives verbatim, because an absent row proves nothing", async () => {
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

    expect(res.text).toContain("COULD NOT VERIFY — the re-read answered about a different number");
    expect(res.text).toMatch(
      /A4HK900132 is not among the 0 task\(s\) that re-read carries, so its own row could not be read/,
    );
    expect(res.text).toMatch(/^confirmedByReRead: false$/m);
    expect(res.text).toMatch(/^requestedStatusAfter: not known$/m);
    expect(res.text).not.toMatch(/is now frozen/);
  });

  it("the task's own row is still modifiable while the envelope claims released — COULD NOT VERIFY, the report and the row disagree", async () => {
    const before: CtsScriptStep = { status: 200, body: taskStillOpenBody() };
    const release = loadCtsFixture("transport-release-success"); // envelope claims released
    const after: CtsScriptStep = { status: 200, body: taskStillOpenBody() }; // re-read: still Modifiable
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("COULD NOT VERIFY — the report and the task's own row disagree");
    expect(res.text).toMatch(/The re-read did NOT fail/);
    expect(res.text).toMatch(/^confirmedByReRead: false$/m);
    expect(res.text).not.toMatch(/is now frozen/);
    expect(res.text).not.toContain("RELEASED");
  });

  it("the task's own row is still modifiable and the envelope reports an abort — NOT RELEASED, confirmed by the task's own row", async () => {
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

    expect(res.text).toContain("NOT RELEASED — the release was aborted");
    expect(res.text).toMatch(/A4HK900131's task list confirms A4HK900132 is still Modifiable/);
    expect(res.text).toMatch(/^confirmedByReRead: true$/m);
  });

  it("guard: a row this code cannot read as decisive (Protected) proves nothing — falls back to COULD NOT VERIFY rather than guessing", async () => {
    // Same recipe as taskStillOpenBody(), but the sibling task's status is
    // flipped to `L`/Protected instead of `D`/Modifiable — a status
    // `releaseVerdict`'s substituted branch deliberately does not treat as
    // decisive (only `released` and `modifiable` are read).
    const real = loadCtsFixture("transport-details-task-resolves-to-parent");
    const taskMarker = '<tm:task tm:number="A4HK900132"';
    const cut = real.body.indexOf(taskMarker);
    if (cut < 0) throw new Error("fixture shape changed: sibling <tm:task> marker not found");
    const protectedBody =
      real.body.slice(0, cut) +
      real.body
        .slice(cut)
        .replace('tm:status="R" tm:status_text="Released"', 'tm:status="L" tm:status_text="Protected"');
    expect(protectedBody).not.toBe(real.body);

    const before: CtsScriptStep = { status: 200, body: taskStillOpenBody() };
    const release = loadCtsFixture("transport-release-success"); // envelope claims released
    const after: CtsScriptStep = { status: 200, body: protectedBody };
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("COULD NOT VERIFY — the re-read answered about a different number");
    expect(res.text).toMatch(
      /A4HK900131's task list does carry A4HK900132, but it reads Protected, which settles nothing either way/,
    );
    expect(res.text).toMatch(/^confirmedByReRead: false$/m);
    expect(res.text).not.toMatch(/is now frozen/);
  });
});

// ---------------------------------------------------------------------------
// D-23, second half: the "unknown" outcome had exactly one explanation — "the
// re-read failed" — but `trRelease` also produces `unknown` when the re-read
// SUCCEEDS and contradicts the envelope (`verified: true`, no
// `verificationError`). Saying the re-read failed there is simply false.
// ---------------------------------------------------------------------------

describe("abap_transport_release: 'unknown' does not claim a re-read failed when it succeeded (D-23)", () => {
  it("envelope says released, a SUCCESSFUL re-read says modifiable: the note reports a disagreement, not a failure", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const release = loadCtsFixture("transport-release-success"); // reportedReleased true
    const after = loadCtsFixture("transport-details-empty-request"); // still Modifiable
    const { conn } = fakeCtsConnection([before, release, after]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toMatch(/outcome: unknown\b/);
    expect(res.text).toMatch(/verified: true/);
    expect(res.text).toContain("COULD NOT VERIFY — the report and the re-read disagree");
    expect(res.text).toMatch(/The re-read did NOT fail/);
    expect(res.text).not.toMatch(/the re-read that would prove the outcome failed/);
  });

  it("the genuinely-failed re-read still says the re-read failed", async () => {
    const before = loadCtsFixture("transport-details-with-objects");
    const release = loadCtsFixture("transport-release-abort-already-released");
    const rereadFails = loadCtsFixture("transport-delete-error-locked-objects");
    const { conn } = fakeCtsConnection([before, release, rereadFails]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
    );

    expect(res.text).toContain("COULD NOT VERIFY — outcome unknown");
    expect(res.text).toMatch(/the re-read that would prove the outcome failed/);
    expect(res.text).not.toMatch(/The re-read did NOT fail/);
  });
});

// ---------------------------------------------------------------------------
// `create` is the only transport op that hands the gate an object. What
// that buys is decided deliberately.
// ---------------------------------------------------------------------------

describe("abap_transport operation: create — package gating is deliberate", () => {
  it("(a) the target package must be in ABAP_ALLOW_PACKAGES: an unset/empty allowlist refuses before any call", async () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: [] });
    const { conn, calls } = fakeCtsConnection([]);

    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "x" }),
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({ code: "SAFETY_DENIED" });
    expect(calls).toHaveLength(0);
  });

  it("(a) a package outside the allowlist is refused and the refusal names the package allowlist rule, not something else", async () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["ZFOO_*"] });
    const { conn, calls } = fakeCtsConnection([]);

    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "create", package: "ZOTHER", description: "x" }),
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({
      code: "SAFETY_DENIED",
      details: { rule: "package allowlist", package: "ZOTHER" },
    });
    expect(calls).toHaveLength(0);
  });

  it("(b) the package name IS judged by ABAP_ALLOW_NAME_PREFIXES, and the refusal says so rather than calling a package an object outside the customer namespace", async () => {
    // Allowlisted as a package, refused by the object-name prefix list. Before
    // this was made deliberate, the caller got the raw object-name wording
    // ("... is outside the customer namespace") for a package that is inside
    // it, with no hint that ABAP_ALLOW_NAME_PREFIXES was the knob in play.
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowNamePrefixes: ["ZMCP_"],
    });
    const { conn, calls } = fakeCtsConnection([]);

    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "x" }),
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({
      code: "SAFETY_DENIED",
      message: expect.stringContaining("ABAP_ALLOW_NAME_PREFIXES"),
      details: { rule: "object-name allowlist", package: "Z_FLIGHT_ADDITIONAL" },
    });
    expect(calls).toHaveLength(0);
  });

  it("(b) a package that passes both the package allowlist and the name-prefix list still creates", async () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["Z_FLIGHT_*"],
      allowNamePrefixes: ["Z"],
    });
    const fixture = loadCtsFixture("create-transport-response");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "test" }),
      MAX_CHARS,
      gate,
    );

    expect(res.text).toMatch(/Created A4HK900121/);
    expect(calls).toHaveLength(1);
  });

  it("ABAP_ALLOW_TRANSPORTS=[] (deny every transportable write) also refuses creating a request for one — the corr:unresolved decision, fail closed", async () => {
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowTransports: [],
    });
    const { conn, calls } = fakeCtsConnection([]);

    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "x" }),
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({
      code: "SAFETY_DENIED",
      details: { rule: "transport allowlist (fail closed)" },
    });
    expect(calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The two create refusals must NAME EACH OTHER (defect: closed loop).
  //
  // `create` has exactly two ways to be refused before any network call: the
  // package is local (`$…`, nothing to transport) or the package is not
  // allowlisted. Each message used to describe only its own rule, so the
  // obvious repair suggested by one was refused by the other, and a caller on
  // a $TMP-only allowlist could not distinguish "unreachable on THIS
  // configuration" from "unreachable, full stop". The gating itself is
  // unchanged and correct — `(b) a package that passes both …` above proves an
  // ordinary widened allowlist still creates — so what is pinned here is the
  // wording that makes the pair discoverable.
  // -------------------------------------------------------------------------

  it("the local-package refusal names ABAP_ALLOW_PACKAGES, and says plainly that a $TMP-only allowlist leaves create with no satisfiable input", async () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const { conn, calls } = fakeCtsConnection([]);

    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "create", package: "$TMP", description: "x" }),
        MAX_CHARS,
        gate,
      ),
    ).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: expect.stringContaining("nothing to create"),
      hint: expect.stringContaining("ABAP_ALLOW_PACKAGES"),
      details: { package: "$TMP", allowPackages: ["$TMP"] },
    });

    const err = await abapTransport(
      conn,
      transportInput({ operation: "create", package: "$TMP", description: "x" }),
      MAX_CHARS,
      gate,
    ).catch((e: unknown) => e as { hint?: string });
    expect(err.hint).toMatch(/no satisfiable input/);
    expect(calls).toHaveLength(0);
  });

  it("the same refusal does NOT claim 'no satisfiable input' once a transportable package is allowlisted — it points at that package instead", async () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP", "Z_FLIGHT_*"] });
    const { conn } = fakeCtsConnection([]);

    const err = await abapTransport(
      conn,
      transportInput({ operation: "create", package: "$TMP", description: "x" }),
      MAX_CHARS,
      gate,
    ).catch((e: unknown) => e as { hint?: string });

    expect(err.hint).toContain("Z_FLIGHT_*");
    expect(err.hint).not.toMatch(/no satisfiable input/);
  });

  it("the allowlist refusal names the local-package rule, so 'use $TMP instead' is not left as an apparent way round it", async () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
    const { conn, calls } = fakeCtsConnection([]);

    const err = await abapTransport(
      conn,
      transportInput({ operation: "create", package: "ZOTHER", description: "x" }),
      MAX_CHARS,
      gate,
    ).catch((e: unknown) => e as { hint?: string; details?: Record<string, unknown> });

    expect(err.hint).toMatch(/local package/);
    expect(err.hint).toMatch(/nothing\s+to create/);
    expect(err.details).toMatchObject({ allowPackages: ["$TMP"] });
    expect(calls).toHaveLength(0);
  });

  /**
   * The same allowlist-refusal hint opens with "Creating a
   * transport request needs ABAP_ALLOW_WRITE=true, ..." unconditionally,
   * which is dead advice once `ABAP_MODE` is set. `ABAP_ALLOW_PACKAGES` and
   * `ABAP_ALLOW_NAME_PREFIXES` stay live narrowing levers under `ABAP_MODE`
   * too (`src/config.ts`'s `modeOverrides` — unlike `ABAP_ALLOW_WRITE`, they
   * are NOT among the six fully-overridden legacy vars), so only the write
   * clause needed to become mode-aware; both allowlist mentions are
   * unchanged and still correct.
   */
  it("under ABAP_MODE, the same hint names ABAP_MODE=edit/admin instead of ABAP_ALLOW_WRITE, while still naming the live ABAP_ALLOW_PACKAGES/ABAP_ALLOW_NAME_PREFIXES levers", async () => {
    const gate = new SafetyGate({ readOnly: false, allowPackages: ["$TMP"], abapMode: "edit" });
    const { conn } = fakeCtsConnection([]);

    const err = await abapTransport(
      conn,
      transportInput({ operation: "create", package: "ZOTHER", description: "x" }),
      MAX_CHARS,
      gate,
    ).catch((e: unknown) => e as { hint?: string });

    expect(err.hint).toContain("ABAP_MODE=edit or admin (it is edit)");
    expect(err.hint).not.toContain("ABAP_ALLOW_WRITE");
    expect(err.hint).toContain("ABAP_ALLOW_PACKAGES");
    expect(err.hint).toContain("ABAP_ALLOW_NAME_PREFIXES");
  });

  it("a caller-pinned TRKORR allowlist does NOT block create: the request being created has no number yet, so the per-TRKORR pin rule cannot apply", async () => {
    // `corr: {kind:"unresolved"}` is what keeps the deny-all rule above while
    // dropping this one. A list naming only some other request must not stop
    // a NEW request from being created.
    const gate = new SafetyGate({
      readOnly: false,
      allowPackages: ["*"],
      allowTransports: ["A4HK900999"],
    });
    const fixture = loadCtsFixture("create-transport-response");
    const { conn, calls } = fakeCtsConnection([fixture]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "test" }),
      MAX_CHARS,
      gate,
    );

    expect(res.text).toMatch(/Created A4HK900121/);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Journalling caller-driven CTS mutations.
//
// Until this landed, `abap_transport` and `abap_transport_release` mutated CTS
// — create, addUser, setOwner, delete, release — and wrote NOTHING to the
// journal. Release is irreversible, so "nothing" meant an irrecoverable act
// with no record of who performed it.
//
// Every assertion below reads the journal back through a FRESH `Journal`
// instance pointed at the same directory, i.e. it asserts on what actually
// landed on disk, not on an in-memory view — the same idiom as
// `test/session-transport-journal.test.ts`.
//
// The single hardest requirement these tests pin: an entry may never read
// stronger than the answer the tool gave the user. Where the tool renders
// "RELEASED (REPORTED) — NOT CONFIRMED" or "COULD NOT VERIFY", NO terminal
// outcome may be written — `succeeded` would claim a freeze nobody observed
// and `failed` would tell a reader the request is still modifiable when it may
// well be frozen.
// ---------------------------------------------------------------------------

describe("journalling caller-driven CTS mutations", () => {
  let tmp: string;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "abapsmith-tr-tools-journal-"));
    warn = vi.fn();
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  const jcfg = (dir: string, over: Partial<JournalConfig> = {}): JournalConfig => ({
    dir,
    enabled: true,
    maxEntries: 200,
    maxAgeDays: 30,
    ...over,
  });

  const FAKE_CFG = { sid: "A4H", url: "http://a4h.example:50000", client: "001" };

  const deps = (journal?: Journal): TransportJournalDeps => ({
    journal: journal ?? new Journal(jcfg(tmp), "A4H"),
    cfg: FAKE_CFG,
    warn: warn as unknown as (msg: string) => void,
  });

  /** What a human sees: a fresh read of what actually reached the disk. */
  const written = async (): Promise<JournalEntry[]> =>
    await new Journal(jcfg(tmp), "A4H").list();

  /**
   * The one entry this call was supposed to leave behind. `what` is quoted
   * back in the failure so a regression says WHICH entry is missing rather
   * than "expected [] to have length 1".
   */
  const only = async (what: string): Promise<JournalEntry> => {
    const all = await written();
    const summary = all.map((e) => `${e.operation} ${e.object.name} ${e.outcome}`);
    expect(summary, `exactly one journal entry on disk: ${what}`).toHaveLength(1);
    return all[0]!;
  };

  const warnings = (): string[] => warn.mock.calls.map((c) => String(c[0]));

  /** Blob text as the journal's own reader hands it back — no layout guessing. */
  const beforeBlobOf = async (e: JournalEntry): Promise<string> => {
    const text = await new Journal(jcfg(tmp), "A4H").beforeImage(e);
    expect(text, "before blob").toBeTruthy();
    return text!;
  };
  const afterBlobOf = async (e: JournalEntry): Promise<string> => {
    const text = await new Journal(jcfg(tmp), "A4H").afterImage(e);
    expect(text, "after blob").toBeTruthy();
    return text!;
  };

  // -------------------------------------------------------------------------
  // Reads are not mutations
  // -------------------------------------------------------------------------

  it("read-only operations journal nothing at all — a journal that records reads stops being a record of what was changed", async () => {
    const { conn } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      // `list` under a write-permitting gate does a
      // discovery GET for an existing search configuration before its own
      // list GET. Reusing an existing one is a read, not a mutation — this
      // step's presence (and the absence of any POST) is exactly what this
      // test needs to keep proving.
      loadCtsFixture("transport-search-configuration-created"),
      loadCtsFixture("transports-by-config"),
      loadCtsFixture("system-users"),
    ]);

    await abapTransport(
      conn,
      transportInput({ operation: "show", transport: "A4HK900117" }),
      MAX_CHARS,
      openGate(),
      deps(),
    );
    await abapTransport(conn, transportInput({ operation: "list" }), MAX_CHARS, openGate(), deps());
    await abapTransport(conn, transportInput({ operation: "users" }), MAX_CHARS, openGate(), deps());

    expect(await written()).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it("a release DRY RUN journals nothing — it reads and reports, it does not release", async () => {
    const { conn, calls } = fakeCtsConnection([loadCtsFixture("transport-details-with-objects")]);

    await abapTransportRelease(conn, { transport: "A4HK900117" }, MAX_CHARS, openGate(), deps());

    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(await written()).toEqual([]);
  });

  it("an armed release that short-circuits on ALREADY RELEASED journals nothing — no release was attempted, so an entry would be a phantom", async () => {
    const { conn, calls } = fakeCtsConnection([loadCtsFixture("transport-details-released")]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900125", confirm: "A4HK900125" },
      MAX_CHARS,
      openGate(),
      deps(),
    );

    expect(res.text).toContain("ALREADY RELEASED");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(await written()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  it("create files one transport-create entry under the TRKORR itself, marked trSource=caller and settled succeeded", async () => {
    const { conn } = fakeCtsConnection([loadCtsFixture("create-transport-response")]);

    const res = await abapTransport(
      conn,
      transportInput({
        operation: "create",
        package: "Z_FLIGHT_ADDITIONAL",
        description: "task 17 create",
      }),
      MAX_CHARS,
      openGate(),
      deps(),
    );
    expect(res.text).toMatch(/Created A4HK900121/);

    const e = await only("the transport-create entry");
    expect(e.operation).toBe("transport-create");
    // §6.2: filed under the request number, not under the package.
    expect(e.object.name).toBe("A4HK900121");
    expect(e.object.uri).toBe("/sap/bc/adt/cts/transportrequests/A4HK900121");
    expect(e.object.type).toBe("CTS/TR");
    expect(e.object.package).toBe("Z_FLIGHT_ADDITIONAL");
    expect(e.object.description).toBe("task 17 create");
    expect(e.corrNr).toBe("A4HK900121");
    // The field that separates this from the session-transport hook's entries
    // for the very same operation: a human named this one.
    expect(e.trSource).toBe("caller");
    expect(e.outcome).toBe("succeeded");
    expect(e.existedBefore).toBe(false);
    // NOT "confirmed-absent": nothing was checked before creating, and only an
    // explicit confirmed-absent may ever authorise an undo-by-delete.
    expect(e.beforeCapture).toBe("unknown");
    expect(e.systemKey).toBe(systemKey(FAKE_CFG));
    expect(e.tool).toBe("abap_transport create");
    expect(e.irreversible).toBeUndefined();
    expect(warnings()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // addUser / setOwner
  // -------------------------------------------------------------------------

  it("addUser files a transport-add-user entry naming the user and the task the server minted", async () => {
    const { conn } = fakeCtsConnection([addUserBodyWithTask("A4HK900117", "A4HK900118")]);

    await abapTransport(
      conn,
      transportInput({ operation: "addUser", transport: "A4HK900117", user: "developer" }),
      MAX_CHARS,
      openGate(),
      deps(),
    );

    const e = await only("the transport-add-user entry");
    expect(e.operation).toBe("transport-add-user");
    expect(e.object.name).toBe("A4HK900117"); // the REQUEST, not the new task
    expect(e.object.description).toBe("addUser DEVELOPER → task A4HK900118");
    expect(e.outcome).toBe("succeeded");
    expect(e.existedBefore).toBe(true);
    // No read was made, so no before-image provenance is claimed. The derived
    // alternative ("failed") would say a read failed when none was attempted.
    expect(e.beforeCapture).toBe("unknown");
    expect(e.trSource).toBe("caller");
    expect(e.tool).toBe("abap_transport addUser");
  });

  it("addUser records that the server reported no task rather than inventing one", async () => {
    const { conn } = fakeCtsConnection([addUserBodyNoTask("A4HK900117")]);

    await abapTransport(
      conn,
      transportInput({ operation: "addUser", transport: "A4HK900117", user: "developer" }),
      MAX_CHARS,
      openGate(),
      deps(),
    );

    const e = await only("the transport-add-user entry");
    expect(e.object.description).toBe("addUser DEVELOPER (the server reported no task)");
    expect(e.object.description).not.toMatch(/task A4HK/);
  });

  it("setOwner files a transport-set-owner entry naming the NEW owner — the previous one was never read and is not invented", async () => {
    const { conn } = fakeCtsConnection([setOwnerOkBody()]);

    await abapTransport(
      conn,
      transportInput({ operation: "setOwner", transport: "A4HK900117", user: "developer" }),
      MAX_CHARS,
      openGate(),
      deps(),
    );

    const e = await only("the transport-set-owner entry");
    expect(e.operation).toBe("transport-set-owner");
    expect(e.object.name).toBe("A4HK900117");
    expect(e.object.description).toBe("setOwner → DEVELOPER");
    expect(e.outcome).toBe("succeeded");
    expect(e.beforeCapture).toBe("unknown");
    expect(e.before?.bytes).toBe(0); // the fabricated, blob-less image — not evidence
    expect(e.tool).toBe("abap_transport setOwner");
  });

  it("a refused mutation journals nothing — the ceiling stops it before any call, so there is nothing to record", async () => {
    const gate = new SafetyGate({ readOnly: true, allowPackages: [] });
    const { conn, calls } = fakeCtsConnection([]);

    await expect(
      abapTransport(
        conn,
        transportInput({ operation: "addUser", transport: "A4HK900117", user: "developer" }),
        MAX_CHARS,
        gate,
        deps(),
      ),
    ).rejects.toMatchObject({ code: "READ_ONLY" });

    expect(calls).toHaveLength(0);
    expect(await written()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  it("a confirmed delete settles succeeded with existedBefore true", async () => {
    const { conn } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      loadCtsFixture("transport-delete-ok"),
      loadCtsFixture("transport-details-nonexistent-error"),
    ]);

    await abapTransport(
      conn,
      transportInput({ operation: "delete", transport: "A4HK900117", confirm: "A4HK900117" }),
      MAX_CHARS,
      openGate(),
      deps(),
    );

    const e = await only("the transport-delete entry");
    expect(e.operation).toBe("transport-delete");
    expect(e.object.name).toBe("A4HK900117");
    expect(e.object.description).toBe("DELETED — confirmed gone");
    expect(e.outcome).toBe("succeeded");
    expect(e.existedBefore).toBe(true);
    // `trDelete` established existence with its own probe, but this layer holds
    // none of those bytes — so no provenance is claimed for the before-image.
    expect(e.beforeCapture).toBe("unknown");
    expect(e.tool).toBe("abap_transport delete");
  });

  it("a delete of a request that never existed is journalled as FAILED, never as a deletion — the byte-identical empty 200 must not become a record of destroying something", async () => {
    const { conn } = fakeCtsConnection([
      loadCtsFixture("transport-details-nonexistent-error"),
      loadCtsFixture("transport-delete-nonexistent-noop"),
      loadCtsFixture("transport-details-nonexistent-error"),
    ]);

    await abapTransport(
      conn,
      transportInput({ operation: "delete", transport: "A4HK999999", confirm: "A4HK999999" }),
      MAX_CHARS,
      openGate(),
      deps(),
    );

    const e = await only("the transport-delete entry");
    expect(e.outcome).toBe("failed");
    expect(e.error).toBe("NO SUCH REQUEST — nothing was deleted");
    expect(e.existedBefore).toBe(false);
    // The probe positively READ the absence — which is exactly what
    // confirmed-absent means, and the one place this module may claim it.
    expect(e.beforeCapture).toBe("confirmed-absent");
  });

  it("a delete whose verifying re-read fails is left PENDING and warned about, never settled either way", async () => {
    const { conn } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      loadCtsFixture("transport-delete-ok"),
      // Reused for its shape only: a genuine, non-"gone" thrown failure on the
      // re-read (the same reuse the release tests above make).
      loadCtsFixture("transport-delete-error-locked-objects"),
    ]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "delete", transport: "A4HK900117", confirm: "A4HK900117" }),
      MAX_CHARS,
      openGate(),
      deps(),
    );
    expect(res.text).toContain("COULD NOT VERIFY");

    const e = await only("the transport-delete entry");
    expect(e.outcome).toBe("pending");
    expect(e.error).toBeUndefined();
    expect(warnings().join("\n")).toMatch(/A4HK900117/);
    expect(warnings().join("\n")).toMatch(/stays `pending` on purpose/);
    expect(warnings().join("\n")).toMatch(/COULD NOT VERIFY/);
  });

  // -------------------------------------------------------------------------
  // release — the entry may never read stronger than the answer
  // -------------------------------------------------------------------------

  it("a confirmed release settles succeeded, is marked irreversible, and carries BOTH the report's claim and the re-read's status in its after-image (§6.4)", async () => {
    const { conn } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"), // A4HK900117, modifiable
      loadCtsFixture("transport-release-success"),
      loadCtsFixture("transport-details-released"),
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      deps(),
    );
    expect(res.text).toContain("RELEASED — reported and confirmed");

    const e = await only("the transport-release entry the release path must file");
    expect(e.operation).toBe("transport-release");
    expect(e.object.name).toBe("A4HK900117");
    expect(e.corrNr).toBe("A4HK900117");
    expect(e.outcome).toBe("succeeded");
    expect(e.irreversible).toBe(true);
    expect(e.trSource).toBe("caller");
    expect(e.tool).toBe("abap_transport_release");
    // The pre-read really was captured — this is the one operation with a real
    // before-image, because the read that produces it already had to happen.
    expect(e.beforeCapture).toBe("captured");
    expect(e.before?.blob).toBeTruthy();
    const beforeBlob = await beforeBlobOf(e);
    expect(beforeBlob).toMatch(/status: Modifiable \(tm:status=D\)/);
    expect(beforeBlob).toMatch(/requested: A4HK900117/);

    expect(e.after?.blob).toBeTruthy();
    const afterBlob = await afterBlobOf(e);
    expect(afterBlob).toMatch(/verdict: RELEASED — reported and confirmed/);
    expect(afterBlob).toMatch(/outcome: released/);
    expect(afterBlob).toMatch(/reportedReleased: true/); // the report's own claim
    expect(afterBlob).toMatch(/statusAfter: Released \(tm:status=R\)/); // the re-read's tm:status
    expect(afterBlob).toMatch(/confirmedByReRead: true/);
    expect(warnings()).toEqual([]);
  });

  it("a released-despite-abort release settles succeeded and the after-image records the abort report it disbelieved", async () => {
    const { conn } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      loadCtsFixture("transport-release-abort-pre-export-yet-released"), // PU/238
      loadCtsFixture("transport-details-released"),
    ]);

    await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      deps(),
    );

    const e = await only("the transport-release entry the release path must file");
    expect(e.outcome).toBe("succeeded");
    const afterBlob = await afterBlobOf(e);
    expect(afterBlob).toMatch(/outcome: released-despite-abort/);
    expect(afterBlob).toMatch(/reportedReleased: false/); // the envelope said aborted
    expect(afterBlob).toMatch(/statusAfter: Released \(tm:status=R\)/); // the re-read disagreed
    expect(afterBlob).toMatch(/message: PU\/238/);
  });

  it("a REPORTED BUT NOT CONFIRMED release is never journalled as succeeded — the entry stays pending and the verdict is warned, because writing `released` where the tool said NOT CONFIRMED would be worse than no entry at all", async () => {
    const { conn } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      loadCtsFixture("transport-release-success"), // chkrun:status="released"
      loadCtsFixture("transport-delete-error-locked-objects"), // re-read THROWS
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      deps(),
    );
    expect(res.text).toContain("RELEASED (REPORTED) — NOT CONFIRMED");

    const e = await only("the transport-release entry the release path must file");
    // The entry exists — the release attempt is on record, with its
    // before-image — but claims NOTHING about the outcome.
    expect(e.operation).toBe("transport-release");
    expect(e.object.name).toBe("A4HK900117");
    expect(e.irreversible).toBe(true);
    expect(e.outcome).toBe("pending");
    expect(e.outcome).not.toBe("succeeded");
    expect(e.outcome).not.toBe("failed");
    expect(e.after).toBeUndefined();
    // The journal shape cannot express "done, outcome unproven", so the verdict
    // goes to the logger instead — never silently.
    const w = warnings().join("\n");
    expect(w).toMatch(/A4HK900117/);
    expect(w).toMatch(/RELEASED \(REPORTED\) — NOT CONFIRMED/);
    expect(w).toMatch(/stays `pending` on purpose/);
  });

  it("a COULD NOT VERIFY release (report and re-read disagree) is left pending too — neither success nor failure may be written", async () => {
    const { conn } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      loadCtsFixture("transport-release-success"), // envelope: released
      loadCtsFixture("transport-details-empty-request"), // re-read: still modifiable
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      deps(),
    );
    expect(res.text).toContain("COULD NOT VERIFY — the report and the re-read disagree");

    const e = await only("the transport-release entry the release path must file");
    expect(e.outcome).toBe("pending");
    expect(warnings().join("\n")).toMatch(/the report and the re-read disagree/);
  });

  it("a CONFIRMED abort is the one release failure that may be settled `failed`, carrying the verdict as its error", async () => {
    const { conn } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      loadCtsFixture("transport-release-abort-inactive-object"), // EU/829
      loadCtsFixture("transport-details-empty-request"), // still modifiable — the abort is confirmed
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      deps(),
    );
    expect(res.text).toContain("NOT RELEASED — the release was aborted");

    const e = await only("the transport-release entry the release path must file");
    expect(e.outcome).toBe("failed");
    expect(e.error).toMatch(/^NOT RELEASED — the release was aborted\./);
    const afterBlob = await afterBlobOf(e);
    expect(afterBlob).toMatch(/outcome: aborted/);
    expect(afterBlob).toMatch(/confirmedByReRead: true/);
  });

  it("SYNTHETIC: releasing a TASK number, where the parent's post-release re-read carries the task's own RELEASED row, is journalled under the number the CALLER named and settles succeeded", async () => {
    // Same construction as the D-23 release tests above: taskStillOpenBody()
    // gets past the already-released short-circuit so the POST/re-read path
    // actually runs. That exact combination (task still open, parent still
    // open, sibling shape) was never captured live, hence SYNTHETIC.
    const { conn } = fakeCtsConnection([
      { status: 200, body: taskStillOpenBody() },
      loadCtsFixture("transport-release-success"),
      loadCtsFixture("transport-details-task-resolves-to-parent"), // answers about A4HK900131; A4HK900132's own row reads R
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
      deps(),
    );
    expect(res.text).toContain("RELEASED — the task's own row in the parent confirms it");

    const e = await only("the transport-release entry the release path must file");
    // The POST was aimed at A4HK900132; filing this under the parent would
    // record a release of a request nobody asked to release.
    expect(e.object.name).toBe("A4HK900132");
    expect(e.corrNr).toBe("A4HK900132");
    expect(e.object.description).toMatch(/a task; the server's read answered about A4HK900131/);
    // The task's own row in the parent settles it, so this is no
    // longer left `pending` the way an unproven substituted release is.
    expect(e.outcome).toBe("succeeded");
    // The task's own row WAS recovered from the parent's tasks, so the
    // before-image really is about the named number.
    expect(e.beforeCapture).toBe("captured");
    const beforeBlob = await beforeBlobOf(e);
    expect(beforeBlob).toMatch(/requested: A4HK900132/);
    expect(beforeBlob).toMatch(/answered: A4HK900131/);
    expect(beforeBlob).toMatch(/substituted: true/);
    expect(beforeBlob).toMatch(/ownTask: A4HK900132 Modifiable/);
  });

  it("SYNTHETIC: releasing a TASK number, where the parent's post-release re-read no longer LISTS the task at all, stays pending with no after-image — an absent row proves nothing, so the release path must not invent a success (companion to the RELEASED case above)", async () => {
    const { conn } = fakeCtsConnection([
      { status: 200, body: taskStillOpenBody() },
      loadCtsFixture("transport-release-success"),
      { status: 200, body: taskAbsentBody() }, // 0 tasks in the re-read — no row to read
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900132", confirm: "A4HK900132" },
      MAX_CHARS,
      openGate(),
      deps(),
    );
    expect(res.text).toContain("COULD NOT VERIFY — the re-read answered about a different number");

    const e = await only("the transport-release entry the release path must file");
    expect(e.object.name).toBe("A4HK900132");
    expect(e.corrNr).toBe("A4HK900132");
    expect(e.object.description).toMatch(/a task; the server's read answered about A4HK900131/);
    expect(e.outcome).toBe("pending");
    // Unproven never settles, so releaseAfterImage is never written for it.
    expect(e.after).toBeUndefined();
    expect(e.beforeCapture).toBe("captured");
  });

  // -------------------------------------------------------------------------
  // Journal failure: never silent, and for release, never silently released
  // -------------------------------------------------------------------------

  /** A journal whose directory cannot be created: a FILE where a dir must go. */
  const blockedJournal = async (): Promise<Journal> => {
    const blocked = path.join(tmp, "blocked");
    await fsp.writeFile(blocked, "not a directory");
    return new Journal(jcfg(path.join(blocked, "A4H")), "A4H");
  };

  it("a journal that cannot be written does NOT fail a create — the request exists either way — but warns, naming the TRKORR, because recovery is manual", async () => {
    const { conn } = fakeCtsConnection([loadCtsFixture("create-transport-response")]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "x" }),
      MAX_CHARS,
      openGate(),
      deps(await blockedJournal()),
    );

    expect(res.text).toMatch(/Created A4HK900121/);
    const w = warnings().join("\n");
    expect(w).toMatch(/^\[abapsmith\] WARNING:/m);
    expect(w).toMatch(/A4HK900121/);
    expect(w).toMatch(/DID happen on A4H but could NOT be journalled/);
    expect(w).toMatch(/recovery is manual/);
  });

  it("a journal that cannot be written REFUSES an armed release before the POST — an irreversible act we already know we cannot record is not performed", async () => {
    const { conn, calls } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      loadCtsFixture("transport-release-success"),
      loadCtsFixture("transport-details-released"),
    ]);

    await expect(
      abapTransportRelease(
        conn,
        { transport: "A4HK900117", confirm: "A4HK900117" },
        MAX_CHARS,
        openGate(),
        deps(await blockedJournal()),
      ),
    ).rejects.toMatchObject({ code: "JOURNAL_IO" });

    // The pre-read happened; the release POST never did. That is what makes the
    // JOURNAL_IO message ("was NOT attempted") true rather than a guess.
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    expect(calls.some((c) => /newreleasejobs/.test(c.url))).toBe(false);
  });

  it("`ABAP_JOURNAL=off` (a disabled journal) still releases — the fail-closed refusal is about a journal that BROKE, not one deliberately switched off", async () => {
    const off = new Journal(jcfg(tmp, { enabled: false }), "A4H");
    const { conn, calls } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      loadCtsFixture("transport-release-success"),
      loadCtsFixture("transport-details-released"),
    ]);

    const res = await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      deps(off),
    );

    expect(res.text).toContain("RELEASED — reported and confirmed");
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(warnings()).toEqual([]);
  });

  it("an entry that cannot be SETTLED (the mutation already happened) does not fail the call, and the warning states the real outcome", async () => {
    const journal = new Journal(jcfg(tmp), "A4H");
    vi.spyOn(journal, "settle").mockResolvedValue({
      settled: false,
      reason: "io-error",
      error: "ENOSPC",
    });
    const { conn } = fakeCtsConnection([loadCtsFixture("create-transport-response")]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "x" }),
      MAX_CHARS,
      openGate(),
      deps(journal),
    );

    expect(res.text).toMatch(/Created A4HK900121/);
    const w = warnings().join("\n");
    expect(w).toMatch(/A4HK900121/);
    expect(w).toMatch(/could not be settled \(io-error: ENOSPC\)/);
    expect(w).toMatch(/the real outcome was `succeeded`/);
    // The begin() line really did land; only the settle is missing.
    expect((await only("the transport-create entry whose settle failed")).outcome).toBe("pending");
  });

  it("with NO journal deps the tools still work and simply record nothing — the function-level tolerance, which the composition root can no longer reach", async () => {
    const { conn } = fakeCtsConnection([loadCtsFixture("create-transport-response")]);

    const res = await abapTransport(
      conn,
      transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "x" }),
      MAX_CHARS,
      openGate(),
      // No journal deps. NOT what registerTransportTools passes any more:
      // `TransportToolDeps.journal` is required, so that call site always builds
      // a real one and omitting it in src/server.ts is now a compile error (the
      // defect this used to describe is fixed, and pinned by
      // test/session-transport-journal.test.ts §1c). What is pinned HERE is the
      // FUNCTION's contract for a direct caller: mutate CTS, record nothing,
      // never throw.
    );

    expect(res.text).toMatch(/Created A4HK900121/);
    expect(await written()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  it("nothing a journal entry writes to disk — index line or blob — can carry a credential, cookie or CSRF token", async () => {
    const { conn } = fakeCtsConnection([
      loadCtsFixture("transport-details-with-objects"),
      loadCtsFixture("transport-release-success"),
      loadCtsFixture("transport-details-released"),
    ]);
    await abapTransportRelease(
      conn,
      { transport: "A4HK900117", confirm: "A4HK900117" },
      MAX_CHARS,
      openGate(),
      deps(),
    );
    const { conn: conn2 } = fakeCtsConnection([loadCtsFixture("create-transport-response")]);
    await abapTransport(
      conn2,
      transportInput({ operation: "create", package: "Z_FLIGHT_ADDITIONAL", description: "x" }),
      MAX_CHARS,
      openGate(),
      deps(),
    );

    const secrets = /sap-usercontext|MYSAPSSO2|x-csrf-token|password|Authorization|Set-Cookie/i;
    const raw = await fsp.readFile(path.join(tmp, "index.jsonl"), "utf8");
    expect(raw).not.toMatch(secrets);
    expect(raw.length).toBeGreaterThan(0); // the scan actually had something to scan

    // Blobs too — the before/after images are the files most likely to grow a
    // dump of something they should not.
    const blobDir = path.join(tmp, "blobs");
    const blobs = await fsp.readdir(blobDir);
    expect(blobs.length).toBeGreaterThan(0);
    for (const f of blobs) {
      const body = await fsp.readFile(path.join(blobDir, f), "utf8");
      expect(body, f).not.toMatch(secrets);
    }
  });
});
