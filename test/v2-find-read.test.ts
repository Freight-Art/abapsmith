/**
 * Routing coverage for the v2 `abap_find`/`abap_read` handlers
 * (`src/tools/v2/handlers/find.ts` + `read.ts`).
 *
 * Unlike `test/tools-v2-budget.test.ts` (which only exercises bare calls
 * against earlier stubs and forbids any network reach), this file's job is
 * to prove the ROUTING is correct now that the stubs are real: for each
 * `kind`/`view`, mock the exact v1 collaborator the plan says that value
 * must reach, and assert it was invoked with the expected arguments — never a
 * real connection, never a real `SessionPool`/`SafetyGate` wire call, so
 * these stay offline and fast like every other unit suite in this repo. Live
 * verification against the real A4H appliance is a separate, non-automated
 * step, per this project's standing rule that offline-green tests never
 * substitute for it.
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import type { SessionPool } from "../src/adt/pool.js";
import type { SessionTransport } from "../src/adt/session-transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Journal } from "../src/journal.js";

// ---------------------------------------------------------------- mocks ---

const searchSpy = vi.fn();
vi.mock("../src/tools/search.js", () => ({
  abapSearch: (...args: unknown[]) => searchSpy(...args),
}));

const readSpy = vi.fn();
vi.mock("../src/tools/read.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tools/read.js")>("../src/tools/read.js");
  return { ...actual, abapRead: (...args: unknown[]) => readSpy(...args) };
});

const bopfSpy = vi.fn();
vi.mock("../src/tools/bopf.js", () => ({
  runBopfRead: (...args: unknown[]) => bopfSpy(...args),
}));

const fpmSpy = vi.fn();
vi.mock("../src/tools/fpm.js", () => ({
  runFpmReadTool: (...args: unknown[]) => fpmSpy(...args),
}));

const transportSpy = vi.fn();
vi.mock("../src/tools/transport.js", () => ({
  abapTransport: (...args: unknown[]) => transportSpy(...args),
}));

// `view: "contract"` resolves the object and reads raw
// source directly — NOT through the mocked `abapRead` above — then spawns
// the compiled `dist/bin/contract.js` as a real child process. All three are
// faked here so this stays a pure routing test, same as every other case in
// this file: no real ADT connection, no real subprocess, no dependency on a
// prior `npm run build`.
const resolveObjectSpy = vi.fn();
vi.mock("../src/adt/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../src/adt/resolve.js")>("../src/adt/resolve.js");
  return { ...actual, resolveObject: (...args: unknown[]) => resolveObjectSpy(...args) };
});

const readSourceSpy = vi.fn();
vi.mock("../src/adt/source.js", async () => {
  const actual = await vi.importActual<typeof import("../src/adt/source.js")>("../src/adt/source.js");
  return { ...actual, readSource: (...args: unknown[]) => readSourceSpy(...args) };
});

/** Minimal fake `ChildProcess` — just enough of the event/stream surface
 *  `read.ts`'s `runContractSubprocess` actually touches
 *  (`stdout`/`stderr` `"data"`, `"error"`, `"close"`, `stdin.write`/`.end`). */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: (d: unknown) => void; end: () => void };
}
/**
 * Builds a fake child but does NOT schedule its events yet — `runContractSubprocess`
 * awaits several real promises (`resolveObject`, `readSource`, `ensureConnected`)
 * before it ever calls `spawn()`, so scheduling the emit at fixture-construction
 * time (e.g. via a bare `queueMicrotask` here) would fire it before those awaits
 * resolve — with zero listeners attached yet, since `.on("close"/"data"/"error")`
 * is only registered synchronously right after `spawn()` returns. An emit with no
 * listener is silently dropped (except `"error"`, which throws), so the promise in
 * `runContractSubprocess` would then hang forever. Callers must wire `trigger` into
 * `spawnSpy`'s own mock implementation (see the call sites below) so the emit is
 * deferred until `spawn()` — and therefore the real listener registration — has
 * actually happened.
 */
function makeFakeChild(opts: { stdout?: string; stderr?: string; code?: number | null; spawnError?: Error }): {
  child: FakeChild;
  written: string[];
  trigger: () => void;
} {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const written: string[] = [];
  child.stdin = {
    write: (d: unknown) => {
      written.push(String(d));
    },
    end: () => {},
  };
  const trigger = () => {
    queueMicrotask(() => {
      if (opts.spawnError) {
        child.emit("error", opts.spawnError);
        return;
      }
      if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
      child.emit("close", opts.code ?? 0);
    });
  };
  return { child, written, trigger };
}
const spawnSpy = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnSpy(...args),
}));

/** Wires a fake child into `spawnSpy` so its events fire only once `spawn()` is
 *  actually called — see {@link makeFakeChild}'s doc comment for why that
 *  timing matters. */
function wireSpawn(fake: { child: FakeChild; trigger: () => void }): void {
  spawnSpy.mockImplementation(() => {
    fake.trigger();
    return fake.child;
  });
}

const { handleAbapFind } = await import("../src/tools/v2/handlers/find.js");
const { handleAbapRead } = await import("../src/tools/v2/handlers/read.js");
const { SafetyGate } = await import("../src/safety.js");

// ------------------------------------------------------------- fixtures ---

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

const conn = { cfg: { sid: "A4H" } } as unknown as AbapConnection;

/** `SessionPool` (`src/adt/pool.ts`) is an interface, not a class — a fake
 *  implementing only the two methods `find.ts`/`read.ts` ever call is enough;
 *  it invokes the callback with a fixed fake `AbapConnection` synchronously,
 *  never touching a real `HttpClient` — matching the way `test/read-search
 *  .test.ts` avoids the network by stubbing the layer directly beneath the
 *  tool function, just one layer higher here (the pool, not `resolveObject`/
 *  `readSource`). */
function fakePool(): SessionPool {
  return {
    withRead: async (_op: string, fn: (c: AbapConnection) => unknown) => fn(conn),
    withWrite: async (_op: string, _uri: string | undefined, fn: (c: AbapConnection) => unknown) => fn(conn),
  } as unknown as SessionPool;
}

// `journal`/`transport`/`debugDeps` are part of `V2ToolDeps` (grown once
// for every v2 handler) but neither `find.ts` nor `read.ts` reads any of the
// three — other handlers are the ones that do. Faked as opaque objects
// rather than constructed for real (their real constructors need config this
// suite has no reason to assemble) since a routing test for `abap_find`/
// `abap_read` never touches them; if that ever changes, a real call reaching
// through one of these fakes will fail loudly (undefined is not a function),
// not silently.
function deps() {
  return {
    pool: fakePool(),
    safety: new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] }),
    ensureConnected: vi.fn(async () => {}),
    errorResult: (e: unknown) => textResult(String(e), true),
    journal: {} as unknown as Journal,
    transport: {} as unknown as SessionTransport,
    debugDeps: {} as never,
    warn: vi.fn(),
    cfg: {
      maxResponseChars: 20000,
      allowEnhancements: false,
      allowSourcePlugins: false,
      user: "TESTUSER",
      abapMode: "admin" as const,
    },
  };
}

function textOf(res: CallToolResult): string {
  const c = res.content[0];
  return c && c.type === "text" ? c.text : "";
}

beforeEach(() => {
  searchSpy.mockReset();
  readSpy.mockReset();
  bopfSpy.mockReset();
  fpmSpy.mockReset();
  transportSpy.mockReset();
  resolveObjectSpy.mockReset();
  readSourceSpy.mockReset();
  spawnSpy.mockReset();
});

const CLAS_OBJ = {
  system: "A4H",
  type: "CLAS/OC",
  kind: "CLAS",
  label: "Class",
  name: "ZCL_FOO",
  uri: "/sap/bc/adt/oo/classes/zcl_foo",
  mode: "source" as const,
};

// =============================================================================
// abap_find
// =============================================================================

describe("abap_find routing", () => {
  it("bare call self-describes without reaching any collaborator", async () => {
    const res = await handleAbapFind({}, deps());
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("abap_find");
    expect(searchSpy).not.toHaveBeenCalled();
    expect(bopfSpy).not.toHaveBeenCalled();
    expect(fpmSpy).not.toHaveBeenCalled();
    expect(transportSpy).not.toHaveBeenCalled();
  });

  it("default kind routes a repository search to abapSearch", async () => {
    searchSpy.mockResolvedValue({ text: "SEARCH RESULT" });
    const res = await handleAbapFind({ query: "ZCL_*" }, deps());
    expect(searchSpy).toHaveBeenCalledTimes(1);
    const [passedConn, input] = searchSpy.mock.calls[0]!;
    expect(passedConn).toBe(conn);
    expect(input).toMatchObject({ query: "ZCL_*", mode: "objects" });
    expect(textOf(res)).toContain("SEARCH RESULT");
    expect(res.isError).toBeFalsy();
  });

  it('where:"usages" maps to mode:"where_used"', async () => {
    searchSpy.mockResolvedValue({ text: "USAGES" });
    await handleAbapFind({ query: "ZCL_FOO", where: "usages" }, deps());
    const [, input] = searchSpy.mock.calls[0]!;
    expect(input).toMatchObject({ mode: "where_used" });
  });

  it('kind:"class" resolves via specForKeyword to a CLAS/OC type filter', async () => {
    searchSpy.mockResolvedValue({ text: "OK" });
    await handleAbapFind({ query: "ZCL_*", kind: "class" }, deps());
    const [, input] = searchSpy.mock.calls[0]!;
    expect(input).toMatchObject({ type: "CLAS/OC" });
  });

  it('kind:"bo" routes to runBopfRead in mode:"search"', async () => {
    bopfSpy.mockResolvedValue(textResult("BOPF SEARCH RESULT"));
    const res = await handleAbapFind({ kind: "bo", query: "ZBOPF_*", max: 5 }, deps());
    expect(bopfSpy).toHaveBeenCalledTimes(1);
    const [, boArgs] = bopfSpy.mock.calls[0]!;
    expect(boArgs).toMatchObject({ mode: "search", query: "ZBOPF_*", object_type: "BOBF", max_results: 5 });
    expect(textOf(res)).toContain("BOPF SEARCH RESULT");
  });

  it('kind:"fpm" routes to runFpmReadTool in mode:"find"', async () => {
    fpmSpy.mockResolvedValue(textResult("FPM SEARCH RESULT"));
    const res = await handleAbapFind({ kind: "fpm", query: "Z_CFG*" }, deps());
    expect(fpmSpy).toHaveBeenCalledTimes(1);
    const [, fpmArgs] = fpmSpy.mock.calls[0]!;
    expect(fpmArgs).toMatchObject({ mode: "find", query: "Z_CFG*" });
    expect(textOf(res)).toContain("FPM SEARCH RESULT");
  });

  it('kind:"transport" routes to abapTransport with operation:"list"', async () => {
    transportSpy.mockResolvedValue({ text: "TRANSPORT LIST" });
    const res = await handleAbapFind({ kind: "transport", query: "TESTUSER" }, deps());
    expect(transportSpy).toHaveBeenCalledTimes(1);
    const [passedConn, input] = transportSpy.mock.calls[0]!;
    expect(passedConn).toBe(conn);
    expect(input).toMatchObject({ operation: "list", user: "TESTUSER" });
    expect(textOf(res)).toContain("TRANSPORT LIST");
  });

  // The transport branch used to reach the network without consulting the gate
  // at all, unlike every other branch of this handler. A gate some read paths
  // skip is not a gate.
  it('kind:"transport" passes through the read gate before reaching abapTransport', async () => {
    transportSpy.mockResolvedValue({ text: "TRANSPORT LIST" });
    const d = deps();
    const assertSpy = vi.spyOn(d.safety, "assert");

    await handleAbapFind({ kind: "transport", query: "TESTUSER" }, d);

    expect(assertSpy).toHaveBeenCalledWith("read");
    expect(transportSpy).toHaveBeenCalledTimes(1);
  });

  it('kind:"badi" returns structured UNSUPPORTED without calling any collaborator', async () => {
    const res = await handleAbapFind({ kind: "badi", query: "ZBADI" }, deps());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("UNSUPPORTED");
    expect(searchSpy).not.toHaveBeenCalled();
    expect(bopfSpy).not.toHaveBeenCalled();
    expect(fpmSpy).not.toHaveBeenCalled();
    expect(transportSpy).not.toHaveBeenCalled();
  });

  it('where:"package" returns structured UNSUPPORTED (never silently treated as repository)', async () => {
    const res = await handleAbapFind({ query: "ZCL_FOO", where: "package" }, deps());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("UNSUPPORTED");
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("an unrecognised kind returns UNKNOWN_KIND, not a silent fallback search", async () => {
    const res = await handleAbapFind({ query: "X", kind: "spaceship" }, deps());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("UNKNOWN_KIND");
    // unknownValue's claim: a legal kind would work.
    expect(textOf(res)).toContain("retryable: true");
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("a missing query on the default search path is BAD_INPUT", async () => {
    const res = await handleAbapFind({}, deps());
    // {} alone is a bare call (isBareCall) — force a non-bare, still-empty-query call.
    const res2 = await handleAbapFind({ where: "usages" }, deps());
    expect(res2.isError).toBe(true);
    expect(textOf(res2)).toContain("BAD_INPUT");
    void res;
  });
});

// =============================================================================
// abap_read
// =============================================================================

describe("abap_read routing", () => {
  it("bare call self-describes without reaching any collaborator", async () => {
    const res = await handleAbapRead({}, deps());
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain("abap_read");
    expect(readSpy).not.toHaveBeenCalled();
    expect(bopfSpy).not.toHaveBeenCalled();
    expect(fpmSpy).not.toHaveBeenCalled();
  });

  it("default view (source) routes to abapRead with outline unset", async () => {
    readSpy.mockResolvedValue({ text: "SOURCE", etag: '"W/x"' });
    const res = await handleAbapRead({ object: "ZCL_FOO" }, deps());
    expect(readSpy).toHaveBeenCalledTimes(1);
    const [passedConn, input] = readSpy.mock.calls[0]!;
    expect(passedConn).toBe(conn);
    expect(input).toMatchObject({ object: "ZCL_FOO", outline: false });
    expect(textOf(res)).toContain("SOURCE");
  });

  it('view:"outline" sets outline:true', async () => {
    readSpy.mockResolvedValue({ text: "OUTLINE" });
    await handleAbapRead({ object: "ZCL_FOO", view: "outline" }, deps());
    const [, input] = readSpy.mock.calls[0]!;
    expect(input).toMatchObject({ outline: true });
  });

  it('view:"method" requires method and passes it through', async () => {
    readSpy.mockResolvedValue({ text: "METHOD SRC" });
    await handleAbapRead({ object: "ZCL_FOO", view: "method", method: "GET_DATA" }, deps());
    const [, input] = readSpy.mock.calls[0]!;
    expect(input).toMatchObject({ method: "GET_DATA" });
  });

  it('view:"method" without method is BAD_INPUT', async () => {
    const res = await handleAbapRead({ object: "ZCL_FOO", view: "method" }, deps());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("BAD_INPUT");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('view:"metadata" aliases to the default abapRead call', async () => {
    readSpy.mockResolvedValue({ text: "META" });
    await handleAbapRead({ object: "ZCL_FOO", view: "metadata" }, deps());
    expect(readSpy).toHaveBeenCalledTimes(1);
    const [, input] = readSpy.mock.calls[0]!;
    expect(input).toMatchObject({ outline: false });
  });

  // The alias above is the behaviour; this is the caller being TOLD about it.
  // Without the note, an agent that asked for metadata to save tokens got the
  // whole object back with a bare ok:true and no sign the view was ignored.
  it('view:"metadata" says so in a user-visible note, not only in a code comment', async () => {
    readSpy.mockResolvedValue({ text: "META" });
    const res = await handleAbapRead({ object: "ZCL_FOO", view: "metadata" }, deps());
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toContain('view="metadata" has no distinct rendering yet');
  });

  it('view:"source" carries no such note', async () => {
    readSpy.mockResolvedValue({ text: "SRC" });
    const res = await handleAbapRead({ object: "ZCL_FOO", view: "source" }, deps());
    expect(textOf(res)).not.toContain("no distinct rendering");
  });

  it('view:"bopf" routes to runBopfRead in mode:"show"', async () => {
    bopfSpy.mockResolvedValue(textResult("BOPF MODEL"));
    const res = await handleAbapRead({ object: "ZBOPF_ORDER", view: "bopf" }, deps());
    expect(bopfSpy).toHaveBeenCalledTimes(1);
    const [, boArgs] = bopfSpy.mock.calls[0]!;
    expect(boArgs).toMatchObject({ mode: "show", bo: "ZBOPF_ORDER" });
    expect(textOf(res)).toContain("BOPF MODEL");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('view:"fpm" routes to runFpmReadTool in mode:"outline"', async () => {
    fpmSpy.mockResolvedValue(textResult("FPM OUTLINE"));
    const res = await handleAbapRead({ object: "Z_MY_CONFIG", view: "fpm" }, deps());
    expect(fpmSpy).toHaveBeenCalledTimes(1);
    const [, fpmArgs] = fpmSpy.mock.calls[0]!;
    expect(fpmArgs).toMatchObject({ mode: "outline", config_id: "Z_MY_CONFIG", config_type: "00" });
    expect(textOf(res)).toContain("FPM OUTLINE");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('view:"diff" returns structured UNSUPPORTED, not a fake route', async () => {
    const res = await handleAbapRead({ object: "ZCL_FOO", view: "diff" }, deps());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("UNSUPPORTED");
    expect(readSpy).not.toHaveBeenCalled();
    expect(bopfSpy).not.toHaveBeenCalled();
    expect(fpmSpy).not.toHaveBeenCalled();
    expect(resolveObjectSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  describe('view:"contract"', () => {
    it("resolves the object, reads raw source, spawns the extraction subprocess, and returns its stdout", async () => {
      resolveObjectSpy.mockResolvedValue(CLAS_OBJ);
      readSourceSpy.mockResolvedValue({ source: "CLASS zcl_foo DEFINITION.\nENDCLASS.", sourceUri: "x" });
      const fake = makeFakeChild({
        stdout: "CLASS zcl_foo DEFINITION.\nENDCLASS.\n",
        stderr: "1 CLASS … IMPLEMENTATION block(s) reduced to a one-line placeholder each.\n",
        code: 0,
      });
      const { written } = fake;
      wireSpawn(fake);

      const res = await handleAbapRead({ object: "ZCL_FOO", view: "contract" }, deps());

      expect(resolveObjectSpy).toHaveBeenCalledTimes(1);
      expect(resolveObjectSpy.mock.calls[0]![1]).toBe("ZCL_FOO");
      expect(readSourceSpy).toHaveBeenCalledTimes(1);
      expect(readSourceSpy.mock.calls[0]![1]).toBe(CLAS_OBJ);

      // Spawned as a genuine child process (never `import`ed) — argv carries
      // the resolved kind/name, and the raw source went to its stdin.
      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const [execPath, spawnArgs] = spawnSpy.mock.calls[0]!;
      expect(execPath).toBe(process.execPath);
      expect(spawnArgs).toEqual([expect.stringContaining("contract.js"), "CLAS", "ZCL_FOO"]);
      expect(written.join("")).toBe("CLASS zcl_foo DEFINITION.\nENDCLASS.");

      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain("CLASS zcl_foo DEFINITION.");
      expect(textOf(res)).not.toContain("BAD_INPUT");
      // `abapRead` (the v1 whole-source/method/outline path) must never be
      // reached by this view — contract fetches its own raw source directly.
      expect(readSpy).not.toHaveBeenCalled();
      expect(bopfSpy).not.toHaveBeenCalled();
      expect(fpmSpy).not.toHaveBeenCalled();
    });

    it("returns structured UNSUPPORTED for a non-CLAS/INTF kind, without spawning anything", async () => {
      resolveObjectSpy.mockResolvedValue({ ...CLAS_OBJ, type: "PROG/P", kind: "PROG", name: "ZREPORT" });
      const res = await handleAbapRead({ object: "ZREPORT", view: "contract" }, deps());
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("UNSUPPORTED");
      expect(readSourceSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it("returns structured UNSUPPORTED (not a crash) when the subprocess exits non-zero", async () => {
      resolveObjectSpy.mockResolvedValue(CLAS_OBJ);
      readSourceSpy.mockResolvedValue({ source: "GARBAGE {{{", sourceUri: "x" });
      wireSpawn(makeFakeChild({ stderr: "abap-contract: extraction failed: boom\n", code: 1 }));

      const res = await handleAbapRead({ object: "ZCL_FOO", view: "contract" }, deps());
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("UNSUPPORTED");
      expect(textOf(res)).toContain("boom");
    });

    it("returns structured UNSUPPORTED (not a crash) when the subprocess fails to spawn at all", async () => {
      resolveObjectSpy.mockResolvedValue(CLAS_OBJ);
      readSourceSpy.mockResolvedValue({ source: "CLASS zcl_foo DEFINITION.\nENDCLASS.", sourceUri: "x" });
      wireSpawn(makeFakeChild({ spawnError: new Error("ENOENT") }));

      const res = await handleAbapRead({ object: "ZCL_FOO", view: "contract" }, deps());
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("UNSUPPORTED");
      expect(textOf(res)).toContain("npm run build");
    });
  });

  it("an unrecognised view returns UNKNOWN_VIEW", async () => {
    const res = await handleAbapRead({ object: "ZCL_FOO", view: "hologram" }, deps());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("UNKNOWN_VIEW");
    // unknownValue's claim: a legal view would work.
    expect(textOf(res)).toContain("retryable: true");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("missing object is BAD_INPUT for a non-bopf/fpm view", async () => {
    const res = await handleAbapRead({ view: "outline" }, deps());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("BAD_INPUT");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('an unrecognised version is rejected, never silently normalised', async () => {
    const res = await handleAbapRead({ object: "ZCL_FOO", version: "draft" }, deps());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("BAD_INPUT");
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('version:"inactive" passes through to abapRead', async () => {
    readSpy.mockResolvedValue({ text: "INACTIVE SRC" });
    await handleAbapRead({ object: "ZCL_FOO", version: "inactive" }, deps());
    const [, input] = readSpy.mock.calls[0]!;
    expect(input).toMatchObject({ version: "inactive" });
  });
});

// =============================================================================
// What a truncated read is allowed to claim about itself.
// =============================================================================

/**
 * `buildResponse` has always returned `{truncated, hasMore, returnedLines,
 * totalLines, sectionsTruncated}` and this handler has always thrown all five
 * away, then rendered a flat `ok: true`. An agent asking for a 3,000-line
 * object got back 1,100 lines and a success line — and there is no other
 * channel through which it could have found out.
 *
 * The flags are the read half of the fix. The write half refuses; this half is
 * what stops the caller walking into the refusal in the first place.
 */
describe("abap_read truncation is disclosed, not swallowed", () => {
  const TRUNCATED = {
    text: "SOURCE\n\n--- TRUNCATED ---\n",
    etag: "partial:sha256:abc",
    truncated: true,
    hasMore: true,
    returnedLines: 1100,
    totalLines: 3004,
    estimatedTokens: 14_900,
    sectionsTruncated: false,
  };

  it("still reports ok:true — a partial read is a successful partial read", async () => {
    readSpy.mockResolvedValue(TRUNCATED);
    const res = await handleAbapRead({ object: "ZCL_BIG" }, deps());
    // Deliberately NOT an error: `ok:false` becomes MCP `isError:true`, which
    // would make every legitimate offset/limit paging loop look like a failure.
    expect(res.isError).toBeFalsy();
  });

  it("says INCOMPLETE on the ok line itself, where it cannot be skimmed past", async () => {
    readSpy.mockResolvedValue(TRUNCATED);
    const text = textOf(await handleAbapRead({ object: "ZCL_BIG" }, deps()));
    expect(text).toContain("ok: true (INCOMPLETE");
    expect(text).toContain("NOT the whole");
  });

  it("states the counts and both remedies in a note", async () => {
    readSpy.mockResolvedValue(TRUNCATED);
    const text = textOf(await handleAbapRead({ object: "ZCL_BIG" }, deps()));
    expect(text).toContain("INCOMPLETE READ");
    expect(text).toContain("1100");
    expect(text).toContain("3004");
    expect(text).toMatch(/partial:/);
    expect(text).toMatch(/old_string/);
    expect(text).toMatch(/offset/);
  });

  it("offers the next page as a concrete next call, with the offset already worked out", async () => {
    readSpy.mockResolvedValue(TRUNCATED);
    const text = textOf(await handleAbapRead({ object: "ZCL_BIG" }, deps()));
    // 1 (default offset) + 1100 returned.
    expect(text).toContain("1101");
  });

  it("carries offset through into the next call for a page that is not the first", async () => {
    readSpy.mockResolvedValue(TRUNCATED);
    const text = textOf(await handleAbapRead({ object: "ZCL_BIG", offset: 501 }, deps()));
    expect(text).toContain("1601");
  });

  it("a complete read says none of it", async () => {
    readSpy.mockResolvedValue({ text: "SOURCE", etag: "sha256:abc", truncated: false });
    const text = textOf(await handleAbapRead({ object: "ZCL_BIG" }, deps()));
    expect(text).toContain("ok: true");
    expect(text).not.toContain("INCOMPLETE");
  });
});
