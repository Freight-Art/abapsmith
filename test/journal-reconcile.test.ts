/**
 * bin/abap-journal-reconcile.
 *
 * Offline, with a fake `HttpClient` (same lighter pattern as test/undo.test.ts
 * — NOT the heavy multi-session test/helpers/fake-adt.ts, which is built for
 * lock/CSRF/debugger concurrency and is overkill for a script that only ever
 * issues plain GETs).
 *
 * What matters here:
 *   - a stranded `pending` entry whose live source matches its after-image
 *     classifies "succeeded";
 *   - one whose live source still matches its before-image classifies "failed";
 *   - one whose live source matches neither (third-party drift) classifies
 *     "ambiguous", via the same `detectDrift()` undo uses;
 *   - dry-run (the default) never calls `journal.settle()` — pending stays
 *     pending;
 *   - `apply: true` settles the succeeded/failed entries and leaves ambiguous
 *     ones untouched;
 *   - the 5-minute staleness threshold is respected — a fresh `pending` entry
 *     is not even examined unless the threshold is overridden.
 *
 * A `Journal` instance is pointed at a real `mkdtemp()` temp dir and seeded
 * via `journal.begin(...)` left un-finished — simulating a crashed write —
 * exactly like test/undo.test.ts / test/integration-undo.test.ts do. No JSONL
 * is hand-written.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HttpClient, HttpClientOptions, HttpClientResponse } from "abap-adt-api/build/AdtHTTP.js";
import { AbapConnection } from "../src/adt/connection.js";
import { AuthCircuitBreaker } from "../src/adt/circuit-breaker.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { Journal, STALE_PENDING_MS, type JournalConfig } from "../src/journal.js";
import { classify, reconcile } from "../src/bin/journal-reconcile.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const NAME = "ZMCP_RECONCILE_REP";
const URI = "/sap/bc/adt/programs/programs/zmcp_reconcile_rep";
const SRC_URI = `${URI}/source/main`;

const V1 = "REPORT zmcp_reconcile_rep.\nWRITE: / 'one'.\n";
const V2 = "REPORT zmcp_reconcile_rep.\nWRITE: / 'two'.\n";
const V3 = "REPORT zmcp_reconcile_rep.\nWRITE: / 'someone-else'.\n";

interface Recorded {
  method: string;
  url: string;
  qs: Record<string, string>;
  body?: string;
}

const resp = (status: number, body = "", headers: Record<string, unknown> = {}): HttpClientResponse =>
  ({ status, statusText: String(status), body, headers }) as unknown as HttpClientResponse;

const OK_TEXT = { "content-type": "text/plain" };
const OK_XML = { "content-type": "application/xml" };
const LOGIN_HEADERS = { "content-type": "application/xml", "x-csrf-token": "TOKEN123" };

const T000_XML =
  `<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">` +
  `<dataPreview:columns><dataPreview:metadata dataPreview:name="MANDT"/>` +
  `<dataPreview:dataSet><dataPreview:data>001</dataPreview:data></dataPreview:dataSet></dataPreview:columns>` +
  `<dataPreview:columns><dataPreview:metadata dataPreview:name="CCCATEGORY"/>` +
  `<dataPreview:dataSet><dataPreview:data>C</dataPreview:data></dataPreview:dataSet></dataPreview:columns>` +
  `</dataPreview:tableData>`;

const NOT_FOUND_XML = `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/><type id="ExceptionResourceNotFound"/>
  <message lang="EN">${NAME} does not exist</message><properties/></exc:exception>`;

class FakeAdt implements HttpClient {
  readonly calls: Recorded[] = [];
  constructor(private readonly route: (r: Recorded) => HttpClientResponse) {}
  async request(o: HttpClientOptions): Promise<HttpClientResponse> {
    const method = (o.method ?? "GET").toUpperCase();
    const rec: Recorded = { method, url: o.url, qs: (o.qs ?? {}) as Record<string, string>, body: o.body };
    this.calls.push(rec);
    return this.route(rec);
  }
}

function baseRoute(r: Recorded): HttpClientResponse | undefined {
  if (r.url.includes("/compatibility/graph")) return resp(200, "<graph/>", LOGIN_HEADERS);
  if (r.url.endsWith("/discovery")) return resp(200, "<service/>", OK_XML);
  if (r.url.includes("/datapreview/freestyle")) return resp(200, T000_XML, OK_XML);
  if (r.url.includes("/ato/settings")) return resp(200, "<settings/>", OK_XML);
  return undefined;
}

/** Routes every GET of SRC_URI to a fixed answer: a source string, or `undefined` for 404. */
function fixedSourceRoute(source: string | undefined) {
  return (r: Recorded): HttpClientResponse => {
    if (r.url === SRC_URI && r.method === "GET") {
      return source === undefined
        ? resp(404, NOT_FOUND_XML, OK_XML)
        : resp(200, source, { ...OK_TEXT, etag: `srv-${source.length}` });
    }
    return resp(200, "", OK_TEXT);
  };
}

const cfg = (over: Partial<Record<string, unknown>> = {}): Config =>
  ConfigSchema.parse({
    url: "http://sap.invalid:50000",
    user: "DEVELOPER",
    password: "secret",
    sid: "A4H",
    client: "001",
    readOnly: true, // the reconcile CLI always forces this; the fake server ignores it (GET only anyway)
    ...over,
  });

async function connected(route: (r: Recorded) => HttpClientResponse): Promise<AbapConnection> {
  const adt = new FakeAdt((r) => baseRoute(r) ?? route(r));
  const conn = new AbapConnection(cfg(), { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
  await conn.connect();
  return conn;
}

let dir: string;
let journal: Journal;

const jcfg = (over: Partial<JournalConfig> = {}): JournalConfig => ({
  dir,
  enabled: true,
  maxEntries: 200,
  maxAgeDays: 30,
  ...over,
});

let conn: AbapConnection | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "abap-reconcile-"));
  journal = new Journal(jcfg(), "A4H");
});

afterEach(async () => {
  if (conn) {
    await conn.shutdown("test-end").catch(() => {});
    conn = undefined;
  }
  await rm(dir, { recursive: true, force: true });
});

/** Begins a crashed `update` entry (existed before, before/after both captured) and leaves it `pending`. */
async function beginCrashedUpdate(before: string, after: string) {
  const e = await journal.begin({
    operation: "update",
    object: { name: NAME, type: "PROG/P", uri: URI, package: "$TMP" },
    existedBefore: true,
    beforeSource: before,
    afterSource: after,
  });
  expect(e).toBeDefined();
  return e!;
}

/** Begins a crashed `create` entry (did not exist before) and leaves it `pending`. */
async function beginCrashedCreate(after: string) {
  const e = await journal.begin({
    operation: "create",
    object: { name: NAME, type: "PROG/P", uri: URI, package: "$TMP" },
    existedBefore: false,
    beforeCapture: "confirmed-absent",
    afterSource: after,
  });
  expect(e).toBeDefined();
  return e!;
}

/** Begins a crashed `delete` entry (existed before, no after) and leaves it `pending`. */
async function beginCrashedDelete(before: string) {
  const e = await journal.begin({
    operation: "delete",
    object: { name: NAME, type: "PROG/P", uri: URI, package: "$TMP" },
    existedBefore: true,
    beforeSource: before,
  });
  expect(e).toBeDefined();
  return e!;
}

describe("classify()", () => {
  it("is a pure function of entry/action/drift/now (sanity: same inputs, same output)", () => {
    const entry = {
      id: "x",
      ts: new Date().toISOString(),
      system: "A4H",
      operation: "update" as const,
      object: { name: NAME, type: "PROG/P", uri: URI, package: "$TMP" },
      existedBefore: true,
      beforeCapture: "captured" as const,
      outcome: "pending" as const,
    };
    const drift = { drifted: false, reason: "n/a" };
    const r1 = classify(entry, "restore", drift, { exists: true, source: "x" });
    const r2 = classify(entry, "restore", drift, { exists: true, source: "x" });
    expect(r1).toEqual(r2);
  });
});

describe("reconcile() — classification", () => {
  it("classifies a landed write as succeeded when live source matches the after-image", async () => {
    const e = await beginCrashedUpdate(V1, V2);
    conn = await connected(fixedSourceRoute(V2));

    const report = await reconcile(conn, journal, { staleAfterMs: 0 });
    expect(report.checked).toBe(1);
    expect(report.classified).toHaveLength(1);
    expect(report.classified[0]!.entry.id).toBe(e.id);
    expect(report.classified[0]!.classification).toBe("succeeded");
  });

  it("classifies a never-landed write as failed when live source still matches the before-image", async () => {
    await beginCrashedUpdate(V1, V2);
    conn = await connected(fixedSourceRoute(V1));

    const report = await reconcile(conn, journal, { staleAfterMs: 0 });
    expect(report.classified[0]!.classification).toBe("failed");
  });

  it("classifies third-party drift as ambiguous, never succeeded/failed", async () => {
    await beginCrashedUpdate(V1, V2);
    conn = await connected(fixedSourceRoute(V3));

    const report = await reconcile(conn, journal, { staleAfterMs: 0 });
    expect(report.classified[0]!.classification).toBe("ambiguous");
    expect(report.classified[0]!.drift.drifted).toBe(true);
  });

  it("classifies a landed create as succeeded", async () => {
    await beginCrashedCreate(V2);
    conn = await connected(fixedSourceRoute(V2));

    const report = await reconcile(conn, journal, { staleAfterMs: 0 });
    expect(report.classified[0]!.classification).toBe("succeeded");
  });

  it("classifies a never-landed create (still 404) as failed", async () => {
    await beginCrashedCreate(V2);
    conn = await connected(fixedSourceRoute(undefined));

    const report = await reconcile(conn, journal, { staleAfterMs: 0 });
    expect(report.classified[0]!.classification).toBe("failed");
  });

  it("classifies a landed delete (now 404) as succeeded", async () => {
    await beginCrashedDelete(V1);
    conn = await connected(fixedSourceRoute(undefined));

    const report = await reconcile(conn, journal, { staleAfterMs: 0 });
    expect(report.classified[0]!.classification).toBe("succeeded");
  });

  it("classifies a never-landed delete (object still exists) as ambiguous, not failed", async () => {
    // detectDrift's "recreate" branch treats ANY still-existing object as
    // drift, with no content comparison — it cannot tell "delete never ran"
    // from "someone recreated it after the delete actually landed". That is
    // the conservative, correct call for undo-safety, and this script defers
    // to it rather than second-guessing with its own fingerprint comparison.
    await beginCrashedDelete(V1);
    conn = await connected(fixedSourceRoute(V1));

    const report = await reconcile(conn, journal, { staleAfterMs: 0 });
    expect(report.classified[0]!.classification).toBe("ambiguous");
    expect(report.classified[0]!.drift.drifted).toBe(true);
  });
});

describe("reconcile() — staleness threshold", () => {
  it("does not report a fresh pending entry under the default 5-minute threshold", async () => {
    await beginCrashedUpdate(V1, V2);
    conn = await connected(fixedSourceRoute(V2));

    const report = await reconcile(conn, journal, {}); // default staleAfterMs = STALE_PENDING_MS
    expect(report.checked).toBe(0);
    expect(report.classified).toHaveLength(0);
  });

  it("reports the same entry once staleAfterMs is overridden to 0", async () => {
    await beginCrashedUpdate(V1, V2);
    conn = await connected(fixedSourceRoute(V2));

    const report = await reconcile(conn, journal, { staleAfterMs: 0 });
    expect(report.checked).toBe(1);
  });

  it("STALE_PENDING_MS is 5 minutes, shared with abap_journal mode=list (src/journal.ts)", () => {
    expect(STALE_PENDING_MS).toBe(5 * 60_000);
  });
});

describe("reconcile() — dry-run vs. --apply", () => {
  it("dry run (apply omitted) never calls journal.settle(); the entry stays pending", async () => {
    const e = await beginCrashedUpdate(V1, V2);
    conn = await connected(fixedSourceRoute(V2));

    const report = await reconcile(conn, journal, { staleAfterMs: 0 });
    expect(report.applied).toBe(false);
    expect(report.settled).toHaveLength(0);

    const after = await journal.get(e.id);
    expect(after?.outcome).toBe("pending");
  });

  it("apply: true settles succeeded/failed entries and leaves ambiguous ones pending", async () => {
    const succeeded = await beginCrashedUpdate(V1, V2); // will read back V2 -> succeeded
    conn = await connected((r) => {
      // Route by URL only — one object name is shared, so scope with an id-free
      // fixed route since this suite uses one object per test elsewhere; here
      // we only need ONE entry, so fixedSourceRoute(V2) covers it directly.
      return fixedSourceRoute(V2)(r);
    });

    const report = await reconcile(conn, journal, { staleAfterMs: 0, apply: true });
    expect(report.applied).toBe(true);
    expect(report.settled).toHaveLength(1);
    expect(report.settled[0]!.entry.id).toBe(succeeded.id);
    expect(report.settled[0]!.outcome).toBe("succeeded");
    expect(report.settled[0]!.settled).toBe(true);

    const after = await journal.get(succeeded.id);
    expect(after?.outcome).toBe("succeeded");
  });

  it("apply: true never settles an ambiguous (drifted) entry", async () => {
    const e = await beginCrashedUpdate(V1, V2);
    conn = await connected(fixedSourceRoute(V3)); // drifted -> ambiguous

    const report = await reconcile(conn, journal, { staleAfterMs: 0, apply: true });
    expect(report.classified[0]!.classification).toBe("ambiguous");
    expect(report.settled).toHaveLength(0);

    const after = await journal.get(e.id);
    expect(after?.outcome).toBe("pending");
  });

  it("apply: true settles a failed entry as failed", async () => {
    const e = await beginCrashedUpdate(V1, V2);
    conn = await connected(fixedSourceRoute(V1)); // still before-image -> failed

    const report = await reconcile(conn, journal, { staleAfterMs: 0, apply: true });
    expect(report.settled).toHaveLength(1);
    expect(report.settled[0]!.outcome).toBe("failed");

    const after = await journal.get(e.id);
    expect(after?.outcome).toBe("failed");
  });
});

describe("reconcile() — read-only discipline", () => {
  it("issues only GET requests once connected (login's own non-GET traffic is out of scope)", async () => {
    await beginCrashedUpdate(V1, V2);
    // AbapConnection.connect() itself issues a POST to /datapreview/freestyle
    // (abap-adt-api's standard client/T000 login-verification query) before
    // reconcile() is ever called — that is inherent to opening ANY connection,
    // read-only or not, and every other read-only tool in this repo pays the
    // same cost. What matters for this script's safety claim is that
    // reconcile() itself, once connected, never issues anything but GET —
    // so the fake client only starts watching methods after connect() returns.
    const adt = new FakeAdt((r) => (baseRoute(r) ?? fixedSourceRoute(V2)(r)) as HttpClientResponse);
    conn = new AbapConnection(cfg(), { httpClient: adt, log: () => {}, breaker: new AuthCircuitBreaker() });
    await conn.connect();
    const callsAtConnect = adt.calls.length;

    await reconcile(conn, journal, { staleAfterMs: 0, apply: true });
    const callsDuringReconcile = adt.calls.slice(callsAtConnect);
    expect(callsDuringReconcile.length).toBeGreaterThan(0);
    expect(callsDuringReconcile.every((c) => c.method === "GET")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Optional polish: a thin smoke test that the compiled CLI actually runs.
// Requires `npm run build` to have produced dist/bin/journal-reconcile.js,
// so run the build before the suite if you want these to execute. They skip
// in a checkout that hasn't been built, which is why they call `ctx.skip()`
// rather than `return`ing — a test that returns early reports as PASSED,
// which is exactly how a broken entry point stays invisible.
// ---------------------------------------------------------------------------
const distPath = join(__dirname, "..", "dist", "bin", "journal-reconcile.js");
const binPath = join(__dirname, "..", "bin", "abap-journal-reconcile");

const DISABLED_JOURNAL_ENV = {
  ABAP_URL: "http://sap.invalid:50000",
  ABAP_USER: "DEVELOPER",
  ABAP_PASSWORD: "secret",
  ABAP_SID: "A4H",
  ABAP_JOURNAL: "off",
} as const;

async function distIsBuilt(): Promise<boolean> {
  try {
    await import("node:fs/promises").then((fs) => fs.access(distPath));
    return true;
  } catch {
    return false;
  }
}

describe("compiled CLI smoke test", () => {
  it("runs against a disabled journal and exits cleanly, printing nothing more than the disabled notice", async (ctx) => {
    if (!(await distIsBuilt())) {
      ctx.skip(`${distPath} not built — run "npm run build" first`);
      return;
    }

    const env = { ...process.env, ...DISABLED_JOURNAL_ENV };
    const stdout = execFileSync("node", [distPath], { encoding: "utf8", env });
    expect(stdout).toMatch(/Journal is disabled/);
    // Generous budget: this boots @abaplint/core and the whole ADT stack, which
    // on a cold filesystem cache alone can exceed the default timeout.
  }, 120_000);
});

// ---------------------------------------------------------------------------
// `bin/abap-journal-reconcile` was a `#!/usr/bin/env bash` script
// shipped as an npm `bin`. npm always includes `bin` targets in the published
// tarball (regardless of the `files` allowlist) and generates a cmd-shim
// `.cmd`/`.ps1` wrapper for them on Windows, which invokes the target through
// its shebang interpreter — and stock Windows has no bash, so that entry point
// was dead on arrival there.
//
// Nothing in the suite exercised `bin/abap-journal-reconcile` itself, only the
// compiled `dist/bin/journal-reconcile.js` it hands off to, which is why the
// defect was invisible. These two blocks close that gap.
//
// NOTE — this asserts the shim is portable. It asserts NOTHING about whether
// abapsmith as a whole runs on Windows: nothing in this repo has ever been
// executed on Windows, and Windows support therefore remains UNVERIFIED.
// ---------------------------------------------------------------------------
describe("npm bin entry points are Node scripts", () => {
  it("every package.json bin target has a `#!/usr/bin/env node` shebang", async () => {
    const fs = await import("node:fs/promises");
    const root = join(__dirname, "..");
    const pkg = JSON.parse(await fs.readFile(join(root, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };

    const targets = Object.entries(pkg.bin);
    expect(targets.length).toBeGreaterThan(0);

    for (const [name, relPath] of targets) {
      const abs = join(root, relPath);
      // dist/index.js only exists after a build; its shebang comes from
      // src/index.ts, so check the source when the build is absent.
      let toRead = abs;
      if (!(await fs.access(abs).then(() => true, () => false))) {
        const srcEquivalent = abs.replace(/([\\/])dist\1/, "$1src$1").replace(/\.js$/, ".ts");
        expect(
          await fs.access(srcEquivalent).then(() => true, () => false),
          `bin["${name}"] -> ${relPath} does not exist and has no src/ equivalent at ${srcEquivalent}`,
        ).toBe(true);
        toRead = srcEquivalent;
      }
      const firstLine = (await fs.readFile(toRead, "utf8")).split("\n", 1)[0];
      expect(firstLine, `bin["${name}"] (${toRead}) must be a Node script, not a shell script`).toBe(
        "#!/usr/bin/env node",
      );
    }
  });

  it("bin/abap-journal-reconcile is syntactically valid, standalone Node", () => {
    // `node --check` parses without executing.
    expect(() => execFileSync(process.execPath, ["--check", binPath], { encoding: "utf8" })).not.toThrow();
  });
});

// The shim's own contract — argv forwarding, exit-code propagation, symlink
// resolution and the missing-build diagnostic — is exercised against a
// throwaway package root containing a SYNTHETIC stub `dist/bin/journal-
// reconcile.js` rather than against the real compiled CLI. That is deliberate:
// booting the real CLI pulls in @abaplint/core and the whole ADT stack, which
// tells us nothing about the shim and costs seconds per invocation. The one
// test that does need the real thing is the end-to-end case below.
type ShimRun = { status: number | null; stdout: string; stderr: string };

function runShim(binary: string, args: string[] = [], env?: NodeJS.ProcessEnv): ShimRun {
  // spawnSync, not execFileSync: execFileSync returns only stdout on success,
  // so it cannot show that the shim adds nothing to stderr on the happy path.
  const r = spawnSync(process.execPath, [binary, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    env: env ?? process.env,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * A throwaway package root: `<dir>/bin/abap-journal-reconcile` is a copy of the
 * real shim, `<dir>/dist/bin/journal-reconcile.js` is a SYNTHETIC stub (written
 * by hand here, NOT a recorded artefact of any kind) whose body is supplied by
 * the caller.
 */
async function makeFakeRoot(stubBody: string | null): Promise<string> {
  const fs = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "abapsmith-shim-"));
  await fs.mkdir(join(dir, "bin"), { recursive: true });
  await fs.copyFile(binPath, join(dir, "bin", "abap-journal-reconcile"));
  if (stubBody !== null) {
    await fs.mkdir(join(dir, "dist", "bin"), { recursive: true });
    await fs.writeFile(join(dir, "dist", "bin", "journal-reconcile.js"), stubBody, "utf8");
  }
  return dir;
}

// SYNTHETIC stub: reports how it was invoked, so the shim's forwarding can be
// asserted exactly.
const ARGV_STUB = `// SYNTHETIC test stub — not a recording.
process.stdout.write(JSON.stringify({ argv1: process.argv[1], args: process.argv.slice(2) }));
`;

describe("bin/abap-journal-reconcile shim", () => {
  let roots: string[] = [];
  afterEach(async () => {
    for (const d of roots) await rm(d, { recursive: true, force: true });
    roots = [];
  });
  async function root(stub: string | null): Promise<string> {
    const d = await makeFakeRoot(stub);
    roots.push(d);
    return d;
  }

  it("passes no extra arguments when invoked with none, and points argv[1] at the compiled CLI", async () => {
    const dir = await root(ARGV_STUB);
    const run = runShim(join(dir, "bin", "abap-journal-reconcile"));
    expect(run.status).toBe(0);
    const seen = JSON.parse(run.stdout) as { argv1: string; args: string[] };
    expect(seen.args).toEqual([]);
    // argv[1] MUST be the compiled CLI, not the shim: src/bin/journal-reconcile.ts's
    // `invokedAsProgram()` compares realpathSync(argv[1]) against its own module
    // path, so a same-process `import()` would leave main() silently unrun.
    expect(realpathSync(seen.argv1)).toBe(realpathSync(join(dir, "dist", "bin", "journal-reconcile.js")));
  });

  it("forwards every argument byte-for-byte, including spaces, empties and shell metacharacters", async () => {
    const dir = await root(ARGV_STUB);
    // Exactly the cases the old bash `"$@"` had to get right.
    const args = ["--help", "--apply", "a b", "", "--foo=bar", "--", "*", "$dollar", "back\\slash", "ü±"];
    const run = runShim(join(dir, "bin", "abap-journal-reconcile"), args);
    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as { args: string[] }).args).toEqual(args);
  });

  it("propagates the compiled CLI's exit code", async () => {
    for (const code of [0, 1, 3, 42]) {
      const dir = await root(`// SYNTHETIC test stub — not a recording.\nprocess.exit(${code});\n`);
      expect(runShim(join(dir, "bin", "abap-journal-reconcile")).status, `exit code ${code}`).toBe(code);
    }
  });

  it("keeps stdout and stderr separate and adds nothing of its own to either", async () => {
    const dir = await root(
      `// SYNTHETIC test stub — not a recording.\nprocess.stdout.write("OUT");\nprocess.stderr.write("ERR");\n`,
    );
    const run = runShim(join(dir, "bin", "abap-journal-reconcile"));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("OUT");
    expect(run.stderr).toBe("ERR");
  });

  it("resolves its own real path when invoked through a symlink, as npm's bin linking does", async (ctx) => {
    if (process.platform === "win32") {
      ctx.skip("symlink creation needs elevation on Windows");
      return;
    }
    // npm links `node_modules/.bin/abap-journal-reconcile` at the consumer's
    // package root, so the shim is normally invoked THROUGH a symlink from an
    // unrelated directory and must still find `../dist/bin/...` relative to its
    // REAL location. That is what the old bash `readlink` loop was for, and what
    // `realpathSync` replaces. Two hops, because `npx` can produce a chain.
    const fs = await import("node:fs/promises");
    const dir = await root(ARGV_STUB);
    const linkDir = await mkdtemp(join(tmpdir(), "abapsmith-binlink-"));
    roots.push(linkDir);
    const hop1 = join(linkDir, "hop1");
    const hop2 = join(linkDir, "abap-journal-reconcile");
    await fs.symlink(join(dir, "bin", "abap-journal-reconcile"), hop1);
    await fs.symlink(hop1, hop2);

    const run = runShim(hop2);
    expect(run.status).toBe(0);
    expect(realpathSync((JSON.parse(run.stdout) as { argv1: string }).argv1)).toBe(
      realpathSync(join(dir, "dist", "bin", "journal-reconcile.js")),
    );
  });

  it("still resolves correctly under --preserve-symlinks-main, which import.meta.url alone would not", async (ctx) => {
    if (process.platform === "win32") {
      ctx.skip("symlink creation needs elevation on Windows");
      return;
    }
    // Without the explicit realpathSync, this flag (settable via NODE_OPTIONS)
    // leaves import.meta.url pointing at the symlink and the ../dist/ lookup
    // resolves against the wrong directory.
    const fs = await import("node:fs/promises");
    const dir = await root(ARGV_STUB);
    const linkDir = await mkdtemp(join(tmpdir(), "abapsmith-binlink-pm-"));
    roots.push(linkDir);
    const link = join(linkDir, "abap-journal-reconcile");
    await fs.symlink(join(dir, "bin", "abap-journal-reconcile"), link);

    const run = runShim(link, [], { ...process.env, NODE_OPTIONS: "--preserve-symlinks-main" });
    expect(run.status).toBe(0);
    expect(realpathSync((JSON.parse(run.stdout) as { argv1: string }).argv1)).toBe(
      realpathSync(join(dir, "dist", "bin", "journal-reconcile.js")),
    );
  });

  it("fails loudly, on stderr with a non-zero exit, when dist/ has not been built", async () => {
    const dir = await root(null); // no dist/ at all
    const run = runShim(join(dir, "bin", "abap-journal-reconcile"));
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("abap-journal-reconcile");
    expect(run.stderr).toMatch(/npm run build/);
  });

  it("runs the real compiled CLI end-to-end", async (ctx) => {
    if (!(await distIsBuilt())) {
      ctx.skip(`${distPath} not built — run "npm run build" first`);
      return;
    }
    const run = runShim(binPath, [], { ...process.env, ...DISABLED_JOURNAL_ENV });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/Journal is disabled/);
    // Booting the real CLI drags in @abaplint/core and the whole ADT stack; on a
    // cold filesystem cache that alone can exceed the default 5s/30s budget.
  }, 120_000);
});
