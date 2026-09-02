import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BODY_DUMP_DIR_ENV,
  REDACTED,
  captureErrorBody,
  redactUrlForCapture,
} from "../src/error-capture.js";
import { adtErrorFromException } from "../src/debug/transport.js";
import { DIAGNOSTIC_BODY_MAX, isTruncated } from "../src/truncate.js";

/**
 * Offline only. Nothing here touches the network — the "errors" are hand-built
 * objects shaped exactly like what `abap-adt-api` throws on the two landings of
 * `AdtException.js:147`.
 */

const dirs: string[] = [];

function freshDumpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "abapsmith-error-capture-"));
  dirs.push(d);
  return d;
}

function captureFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith("adt-error-"));
}

afterEach(() => {
  delete process.env[BODY_DUMP_DIR_ENV];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The `AdtHttpException` shape: no `properties`, no own `response`, body only under `parent`. */
function adtHttpExceptionLike(body: string) {
  class AdtHttpException extends Error {
    parent: unknown;
    constructor(parent: unknown) {
      super("An exception was raised");
      this.parent = parent;
    }
    get status(): number {
      return 500;
    }
  }
  return new AdtHttpException({
    response: { body, status: 500, statusText: "Internal Server Error", headers: {} },
  });
}

describe("captureErrorBody — gating", () => {
  it("writes nothing and returns undefined when ABAPSMITH_BODY_DUMP_DIR is unset", () => {
    const dir = freshDumpDir();
    delete process.env[BODY_DUMP_DIR_ENV];

    const result = captureErrorBody("test", "/sap/bc/adt/x", adtHttpExceptionLike("body"));

    expect(result).toBeUndefined();
    expect(captureFiles(dir)).toEqual([]);
  });

  it("writes nothing when the env var is set to the empty string", () => {
    const dir = freshDumpDir();
    process.env[BODY_DUMP_DIR_ENV] = "";

    expect(captureErrorBody("test", "/x", adtHttpExceptionLike("body"))).toBeUndefined();
    expect(captureFiles(dir)).toEqual([]);
  });

  it("does not throw when it is handed nothing at all", () => {
    process.env[BODY_DUMP_DIR_ENV] = freshDumpDir();
    expect(() => captureErrorBody("test", "/x", undefined)).not.toThrow();
    expect(() => captureErrorBody("test", "/x", "a string, not an error")).not.toThrow();
    expect(() => captureErrorBody("test", "/x", null)).not.toThrow();
  });
});

describe("captureErrorBody — file contents", () => {
  it("captures the full body from parent.response.body with the structured header", () => {
    const dir = freshDumpDir();
    process.env[BODY_DUMP_DIR_ENV] = dir;
    const body = "<exc:exception>" + "z".repeat(60_000) + "</exc:exception>";

    const filePath = captureErrorBody(
      "adtErrorFromException",
      "/sap/bc/adt/debugger/stack?emode=_&semanticURIs=true",
      adtHttpExceptionLike(body),
    );

    expect(filePath).toBeDefined();
    const written = readFileSync(filePath as string, "utf8");

    expect(written).toContain("source: adtErrorFromException");
    expect(written).toContain("requestPath: /sap/bc/adt/debugger/stack?emode=_&semanticURIs=true");
    expect(written).toContain("constructorName: AdtHttpException");
    expect(written).toContain("status: 500");
    expect(written).toContain("hasParent: true");
    expect(written).toContain("hasParentResponse: true");
    expect(written).toContain("bodyOrigin: parent.response.body");
    expect(written).toContain(`bodyLength: ${body.length}`);
    // The body is written verbatim and in full — no 20 000-char truncation.
    expect(written.endsWith(body)).toBe(true);
  });

  it("records the OTHER :147 landing — no axios response anywhere — distinguishably", () => {
    const dir = freshDumpDir();
    process.env[BODY_DUMP_DIR_ENV] = dir;

    class AdtHttpException extends Error {
      parent = new Error("boom"); // a parent, but no `.response` on it
    }
    const filePath = captureErrorBody("http-guard", "/sap/bc/adt/x", new AdtHttpException("nope"));

    const written = readFileSync(filePath as string, "utf8");
    expect(written).toContain("hasParent: true");
    expect(written).toContain("hasParentResponse: false");
    expect(written).toContain("bodyOrigin: none");
    expect(written).toContain("bodyLength: 0");
  });

  it("prefers an own response.body over the parent's (the http-guard layer)", () => {
    const dir = freshDumpDir();
    process.env[BODY_DUMP_DIR_ENV] = dir;

    const filePath = captureErrorBody("http-guard", "/x", {
      response: { body: "OWN", status: 500 },
      parent: { response: { body: "PARENT" } },
    });

    const written = readFileSync(filePath as string, "utf8");
    expect(written).toContain("bodyOrigin: response.body");
    expect(written.endsWith("OWN")).toBe(true);
    expect(written).not.toContain("PARENT");
  });

  it("gives every capture a unique file name", () => {
    const dir = freshDumpDir();
    process.env[BODY_DUMP_DIR_ENV] = dir;

    for (let i = 0; i < 5; i++) captureErrorBody("test", "/x", adtHttpExceptionLike("b" + i));

    expect(captureFiles(dir).length).toBe(5);
  });

  it("creates the dump directory if it does not exist yet", () => {
    const nested = join(freshDumpDir(), "deep", "deeper");
    process.env[BODY_DUMP_DIR_ENV] = nested;

    const filePath = captureErrorBody("test", "/x", adtHttpExceptionLike("hi"));
    expect(existsSync(filePath as string)).toBe(true);
  });
});

describe("captureErrorBody — credentials", () => {
  it("writes no header material at all — no Authorization, Cookie or Set-Cookie", () => {
    const dir = freshDumpDir();
    process.env[BODY_DUMP_DIR_ENV] = dir;

    const filePath = captureErrorBody("http-guard", "/sap/bc/adt/x", {
      response: {
        body: "harmless",
        status: 401,
        headers: {
          authorization: "Basic ZGV2ZWxvcGVyOnN1cGVyc2VjcmV0",
          cookie: "SAP_SESSIONID_A4H_001=SECRETVALUE",
          "set-cookie": ["MYSAPSSO2=ANOTHERSECRET; Path=/"],
        },
      },
    });

    const written = readFileSync(filePath as string, "utf8");
    expect(written).not.toContain("ZGV2ZWxvcGVyOnN1cGVyc2VjcmV0");
    expect(written).not.toContain("SAP_SESSIONID_A4H_001");
    expect(written).not.toContain("MYSAPSSO2");
    expect(written.toLowerCase()).not.toContain("authorization");
    expect(written.toLowerCase()).not.toContain("set-cookie");
  });

  it("redacts credential-shaped query parameters out of the request path", () => {
    const dir = freshDumpDir();
    process.env[BODY_DUMP_DIR_ENV] = dir;

    const filePath = captureErrorBody(
      "test",
      "/sap/bc/adt/x?emode=_&sap-password=hunter2&csrfToken=abc123&sessionId=zzz&semanticURIs=true",
      adtHttpExceptionLike("body"),
    );

    const written = readFileSync(filePath as string, "utf8");
    expect(written).not.toContain("hunter2");
    expect(written).not.toContain("abc123");
    expect(written).not.toContain("zzz");
    // Non-credential params survive — the path must stay diagnosable.
    expect(written).toContain("emode=_");
    expect(written).toContain("semanticURIs=true");
  });

  it("redacts a credential-shaped fragment out of the request path, with or without a query part", () => {
    const dir = freshDumpDir();
    process.env[BODY_DUMP_DIR_ENV] = dir;

    const noQuery = captureErrorBody("test", "/sap/bc/adt/x#token=hunter2", adtHttpExceptionLike("body"));
    expect(readFileSync(noQuery as string, "utf8")).not.toContain("hunter2");

    const glued = captureErrorBody(
      "test",
      "/sap/bc/adt/x?emode=_#sap-password=hunter3",
      adtHttpExceptionLike("body"),
    );
    const writtenGlued = readFileSync(glued as string, "utf8");
    expect(writtenGlued).not.toContain("hunter3");
    // Non-credential query param survives even with a credential fragment attached.
    expect(writtenGlued).toContain("emode=_");
  });

  it("preserves a legitimate ;-separated ADT class-member fragment on disk", () => {
    const dir = freshDumpDir();
    process.env[BODY_DUMP_DIR_ENV] = dir;

    const filePath = captureErrorBody(
      "test",
      "/sap/bc/adt/oo/classes/ZCL_X/source/main#type=CLAS/OC;name=FOO",
      adtHttpExceptionLike("body"),
    );

    expect(readFileSync(filePath as string, "utf8")).toContain("type=CLAS/OC;name=FOO");
  });

  it("redactUrlForCapture leaves a query-less path untouched", () => {
    expect(redactUrlForCapture("/sap/bc/adt/debugger/stack")).toBe("/sap/bc/adt/debugger/stack");
    expect(redactUrlForCapture("/x?a=1")).toBe("/x?a=1");
    expect(redactUrlForCapture("/x?token=t")).toBe(`/x?token=${REDACTED}`);
  });

  it("redacts a credential-shaped fragment even with no query part", () => {
    expect(redactUrlForCapture("/path#token=abc123")).toBe(`/path#token=${REDACTED}`);
  });

  it("redacts a credential-shaped fragment glued onto a query, keeping the query param", () => {
    const result = redactUrlForCapture("/path?foo=bar#token=abc123");
    expect(result).toBe(`/path?foo=bar#token=${REDACTED}`);
    expect(result).toContain("foo=bar");
  });

  it("redacts the query and fragment credential independently, not by the old query/fragment glue coincidence", () => {
    // Old code: text.indexOf("?") found "?", but split("&") on the query slice
    // produced one pair "token=1#session=abc" whose *name* was still "token" —
    // so it matched CREDENTIAL_PARAM and got fully replaced, swallowing the
    // fragment along with it. That looked redacted but only by coincidence:
    // the fragment was never recognized as a fragment. Pin the exact output so
    // a future refactor can't drift back to relying on that.
    expect(redactUrlForCapture("/x?token=1#session=abc")).toBe(`/x?token=${REDACTED}#session=${REDACTED}`);
  });

  it("preserves a legitimate non-credential fragment using this codebase's ADT class-member idiom", () => {
    const url = "/sap/bc/adt/oo/classes/ZCL_X/source/main#type=CLAS/OC;name=FOO";
    expect(redactUrlForCapture(url)).toBe(url);
  });

  it("round-trips a fragment-only path with no query and no credential", () => {
    expect(redactUrlForCapture("/path#plain")).toBe("/path#plain");
  });

  it("round-trips an empty fragment losslessly", () => {
    expect(redactUrlForCapture("/path?a=1#")).toBe("/path?a=1#");
  });
});

describe("captureErrorBody — failure isolation", () => {
  it("swallows an unwritable dump directory instead of propagating", () => {
    // A regular file blocking a path component makes mkdirSync fail with
    // ENOTDIR regardless of effective permissions (root can bypass mode bits).
    const blockerDir = freshDumpDir();
    const blockerFile = join(blockerDir, "not-a-directory");
    writeFileSync(blockerFile, "blocker");
    process.env[BODY_DUMP_DIR_ENV] = join(blockerFile, "sub", "dir");

    let result: string | undefined = "unset";
    expect(() => {
      result = captureErrorBody("test", "/x", adtHttpExceptionLike("body"));
    }).not.toThrow();
    expect(result).toBeUndefined();
  });

  it("survives an exception object whose getters throw", () => {
    process.env[BODY_DUMP_DIR_ENV] = freshDumpDir();

    const hostile = {
      get response(): unknown {
        throw new Error("hostile getter");
      },
      get parent(): unknown {
        throw new Error("hostile getter");
      },
      get status(): number {
        throw new Error("hostile getter");
      },
    };

    expect(() => captureErrorBody("test", "/x", hostile)).not.toThrow();
  });
});

describe("adtErrorFromException integration", () => {
  it("classification is byte-for-byte unchanged whether capture is on or off", () => {
    const thrown = adtHttpExceptionLike("<exc:exception/>");

    delete process.env[BODY_DUMP_DIR_ENV];
    const off = adtErrorFromException(thrown, "/sap/bc/adt/debugger/stack");

    const dir = freshDumpDir();
    process.env[BODY_DUMP_DIR_ENV] = dir;
    const on = adtErrorFromException(thrown, "/sap/bc/adt/debugger/stack");

    expect(on).toEqual(off);
    // ...and the capture did happen on the second call only.
    expect(captureFiles(dir).length).toBe(1);
  });

  it("captures the full body on disk; the classifier keeps a bounded excerpt of it", () => {
    const dir = freshDumpDir();
    process.env[BODY_DUMP_DIR_ENV] = dir;
    const body = "<exc:exception><namespace/><type>AdiFailed</type></exc:exception>";

    const err = adtErrorFromException(adtHttpExceptionLike(body), "/sap/bc/adt/debugger/stack");

    // ------------------------------------------------------------------------
    // DELIBERATE CONTRACT CHANGE (2026-08). This assertion previously read
    //     expect(err.bodyExcerpt).not.toContain("AdiFailed");
    // under the comment "the classifier is blind to the body — this is the
    // defect being documented", and the test was named "captures the body that
    // adtErrorFromException itself cannot see".
    //
    // WHY THAT WAS WRONG, and what actually changed. `adtErrorFromException`
    // (src/debug/transport.ts:549) is byte-for-byte unchanged — it has always
    // done `bodyExcerpt: truncateDiagnosticBody(rawBody || message)` with
    // `rawBody = info?.response?.body ?? ""`. What changed is its collaborator:
    // `adtExceptionInfo` (src/adt/session.ts) used to return
    // `response: any.response ?? undefined` — own response only — and this
    // fixture is the `AdtHttpException` shape, which carries its response ONE
    // LEVEL DOWN on `.parent`. So the old "blindness" was not a property of the
    // classifier at all; it was a gap in `pickResponse`'s reach. That gap is now
    // closed on purpose (src/adt/session.ts:301 `pickResponse`, one bounded hop,
    // documented and verified against the installed `abap-adt-api` build)
    // because the ICM short-dump page — `text/html`, never parseable as an
    // `<exc:exception>` envelope — is reachable ONLY via `parent.response`, and
    // losing it was the whole reason HTTP 500s were undiagnosable.
    //
    // WHY BODY TEXT HERE IS NOT A LEAK. `AdtError.bodyExcerpt` is specified
    // (src/debug/types.ts:552-564) as "truncated response body … for
    // DISPLAY/LOGGING ONLY", and the PRIMARY producer, `parseAdtError`
    // (src/debug/xml-response.ts:1140), has always filled it with exactly this:
    // `truncateDiagnosticBody(body)`. That is pinned by
    // test/debug-xml-response.test.ts:621/642 and test/debug-client.test.ts:464.
    // A body excerpt in this field is the contract; the old expectation pinned a
    // collaborator's limitation instead, so it went stale the moment the
    // limitation was fixed.
    //
    // WHAT THE CONTRACT DOES FORBID is an UNBOUNDED body reaching model context.
    // That is a real invariant with a real failure mode, so it is asserted
    // directly by the next test rather than left implicit in a `.not.toContain`.
    // ------------------------------------------------------------------------
    expect(err.bodyExcerpt).toBe(body);
    // Still blind to what it was ALWAYS blind to, and that part is unchanged:
    // this shape carries no `.properties`, so the language-independent
    // discriminator genuinely is not recoverable from the thrown object.
    expect(err.exceptionClassNames).toBeUndefined();
    // The out-of-band capture records the same bytes, in full, on disk.
    const written = readFileSync(join(dir, captureFiles(dir)[0] as string), "utf8");
    expect(written).toContain("AdiFailed");
    expect(written).toContain("bodyOrigin: parent.response.body");
  });

  it("never lets an unbounded body into bodyExcerpt — capped, marked, spilled to disk", () => {
    const dir = freshDumpDir();
    process.env[BODY_DUMP_DIR_ENV] = dir;
    // The shape the `parent.response` hop exists to recover: an ABAP short dump /
    // ICM error page, which runs to ~165 KB on this appliance.
    const body = "<html>" + "z".repeat(200_000) + "</html>";

    const err = adtErrorFromException(adtHttpExceptionLike(body), "/sap/bc/adt/debugger/stack");

    // Security constraint restated at src/debug/types.ts:552-556 — raw ADT
    // bodies go to disk, never into context wholesale. `truncateDiagnosticBody`
    // caps at DIAGNOSTIC_BODY_MAX and every cut is marked (src/truncate.ts).
    expect(err.bodyExcerpt.length).toBeLessThan(DIAGNOSTIC_BODY_MAX + 500);
    expect(isTruncated(err.bodyExcerpt)).toBe(true);
    // ...while the forensic capture still holds every byte.
    const written = readFileSync(join(dir, captureFiles(dir)[0] as string), "utf8");
    expect(written.endsWith(body)).toBe(true);
  });
});
