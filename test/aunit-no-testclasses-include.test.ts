/**
 * #181: an AUnit run that comes back "unknown" with zero programs and zero
 * alerts almost always means the class has no test-classes include at all,
 * not that grading silently failed. `abapTestObject` probes
 * `${obj.uri}/includes/testclasses` (GET, no side effects) once to tell
 * those cases apart, only for CLAS/OC and only when the run itself gave
 * nothing to go on.
 *
 * Model: test/test-tool-coverage.test.ts (resolveObject stub, fakeConn,
 * gate()), extended with a `get` handler since the probe is a GET.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AbapConnection } from "../src/adt/connection.js";
import { AbapError } from "../src/adt/errors.js";
import type { ResolvedObject } from "../src/adt/resolve.js";
import { SafetyGate } from "../src/safety.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "live-captured");
const read = (f: string): string => readFileSync(join(FIXTURES, f), "utf8");

const ALLPASS_XML = read("852-i75-ut-testrun-allpass.xml");
const EMPTY_RUN_XML =
  '<?xml version="1.0" encoding="utf-8"?><aunit:runResult xmlns:aunit="http://www.sap.com/adt/aunit"/>';

const stub = { object: {} as ResolvedObject };

vi.mock("../src/adt/resolve.js", async (importActual) => ({
  ...(await importActual<typeof import("../src/adt/resolve.js")>()),
  resolveObject: async () => stub.object,
}));

const { abapTest } = await import("../src/tools/test.js");

function resolved(over: Partial<ResolvedObject> = {}): ResolvedObject {
  return {
    system: "A4H",
    type: "CLAS/OC",
    kind: "CLAS",
    label: "Class",
    name: "ZCL_AS_NOTEST",
    uri: "/sap/bc/adt/oo/classes/zcl_as_notest",
    packageName: "$TMP",
    mode: "source",
    activation: "unknown",
    spec: {},
    ...over,
  } as unknown as ResolvedObject;
}

interface Call {
  method: "get" | "post";
  url: string;
  headers: Record<string, string>;
}

type Reply = { body: string; status?: number } | { throws: unknown };
type PostHandler = (url: string, body: string | undefined) => Reply;
type GetHandler = (url: string, opts: { headers?: Record<string, string> }) => Reply;

function fakeConn(opts: { post: PostHandler; get?: GetHandler }): {
  conn: AbapConnection;
  calls: Call[];
} {
  const calls: Call[] = [];
  const post = async (
    url: string,
    reqOpts: { headers?: Record<string, string>; body?: string } = {},
  ) => {
    calls.push({ method: "post", url, headers: reqOpts.headers ?? {} });
    const reply = opts.post(url, reqOpts.body);
    if ("throws" in reply) throw reply.throws;
    return { body: reply.body, status: reply.status ?? 200, headers: {} };
  };
  const get = async (url: string, reqOpts: { headers?: Record<string, string> } = {}) => {
    calls.push({ method: "get", url, headers: reqOpts.headers ?? {} });
    if (!opts.get) throw new Error(`unscripted GET: ${url}`);
    const reply = opts.get(url, reqOpts);
    if ("throws" in reply) throw reply.throws;
    return { body: reply.body, status: reply.status ?? 200, headers: {} };
  };
  const conn = { cfg: { sid: "A4H" }, post, get } as unknown as AbapConnection;
  return { conn, calls };
}

function gate(): SafetyGate {
  return new SafetyGate({ readOnly: false, allowPackages: ["$TMP"] });
}

const PROBE_URL = "/sap/bc/adt/oo/classes/zcl_as_notest/includes/testclasses";

describe("abap_test: CLAS/OC probe for a missing test-classes include", () => {
  it("probe throws NOT_FOUND -> reports NO TESTS RAN, include absent", async () => {
    const { conn, calls } = fakeConn({
      post: () => ({ body: EMPTY_RUN_XML }),
      get: () => ({ throws: new AbapError("NOT_FOUND", "not found", {}) }),
    });
    stub.object = resolved();
    const res = await abapTest(conn, { object: "ZCL_AS_NOTEST" }, 50_000, gate());
    expect(res.text).toContain("outcome: NO TESTS RAN (not a pass)");
    expect(res.text).toContain(
      "NO TESTS RAN. The run reported no test methods and the class has no test-classes " +
        "include (…/includes/testclasses is absent)",
    );
    const gets = calls.filter((c) => c.method === "get");
    expect(gets).toHaveLength(1);
    expect(gets[0]!.url).toBe(PROBE_URL);
    expect(gets[0]!.headers).toEqual({ Accept: "text/plain" });
  });

  it("probe resolves blank -> reports NO TESTS RAN, include empty", async () => {
    const { conn, calls } = fakeConn({
      post: () => ({ body: EMPTY_RUN_XML }),
      get: () => ({ body: "   \n  " }),
    });
    stub.object = resolved();
    const res = await abapTest(conn, { object: "ZCL_AS_NOTEST" }, 50_000, gate());
    expect(res.text).toContain("outcome: NO TESTS RAN (not a pass)");
    expect(res.text).toContain(
      "The run reported no test methods and the class has no test-classes include content " +
        "(…/includes/testclasses is empty)",
    );
    expect(calls.filter((c) => c.method === "get")).toHaveLength(1);
  });

  it("probe resolves non-empty -> outcome stays unknown, reason explains the include exists", async () => {
    const { conn } = fakeConn({
      post: () => ({ body: EMPTY_RUN_XML }),
      get: () => ({ body: "CLASS ltcl_foo DEFINITION FOR TESTING." }),
    });
    stub.object = resolved();
    const res = await abapTest(conn, { object: "ZCL_AS_NOTEST" }, 50_000, gate());
    expect(res.text).toContain("outcome: UNKNOWN (not a pass)");
    expect(res.text).toContain("RESULT NOT GRADED.");
    expect(res.text).toContain(
      "The class does have a non-empty test-classes include, so the empty run result is unexplained",
    );
  });

  it("probe throws a generic error -> outcome stays unknown, reason names the probe failure", async () => {
    const { conn } = fakeConn({
      post: () => ({ body: EMPTY_RUN_XML }),
      get: () => ({ throws: new Error("ECONNRESET") }),
    });
    stub.object = resolved();
    const res = await abapTest(conn, { object: "ZCL_AS_NOTEST" }, 50_000, gate());
    expect(res.text).toContain("outcome: UNKNOWN (not a pass)");
    expect(res.text).toContain("(probe of the test-classes include failed: ECONNRESET)");
  });

  it("a passing run never triggers the probe", async () => {
    const { conn, calls } = fakeConn({
      post: () => ({ body: ALLPASS_XML }),
      get: () => ({ body: "should never be requested" }),
    });
    stub.object = resolved();
    const res = await abapTest(conn, { object: "ZCL_AS_NOTEST" }, 50_000, gate());
    expect(res.text).toContain("outcome: PASSED");
    expect(calls.filter((c) => c.method === "get")).toHaveLength(0);
  });

  it("a non-CLAS/OC object (PROG/P) with an empty run is never probed", async () => {
    const { conn, calls } = fakeConn({
      post: () => ({ body: EMPTY_RUN_XML }),
      get: () => ({ body: "should never be requested" }),
    });
    stub.object = resolved({
      type: "PROG/P",
      kind: "PROG",
      label: "Report",
      uri: "/sap/bc/adt/programs/programs/zas_notest",
    });
    const res = await abapTest(conn, { object: "ZAS_NOTEST" }, 50_000, gate());
    expect(res.text).toContain("outcome: UNKNOWN (not a pass)");
    expect(calls.filter((c) => c.method === "get")).toHaveLength(0);
  });
});
