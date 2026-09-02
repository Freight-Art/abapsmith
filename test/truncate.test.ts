/**
 * Pins the behaviour of src/truncate.ts (review finding 13): the single
 * source of truth for shortening bodies and diagnostic text. The key
 * property under test is the negative control below — nothing may ever be
 * shortened without leaving a detectable marker behind.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIAGNOSTIC_BODY_MAX,
  TRUNCATION_MARKER_PATTERN,
  isDisplayTruncated,
  isTruncated,
  truncateDiagnosticBody,
  truncateForDisplay,
  truncateText,
} from "../src/truncate.js";

describe("truncateText", () => {
  it("returns text at or below the limit unchanged, with no marker", () => {
    const text = "hello";
    const result = truncateText(text, 5);
    expect(result).toBe(text);
    expect(isTruncated(result)).toBe(false);
  });

  it("cuts text above the limit to exactly maxChars of original content, with a marker", () => {
    const text = "a".repeat(50);
    const result = truncateText(text, 10);
    expect(result.slice(0, 10)).toBe("a".repeat(10));
    expect(result).toContain("… [truncated, 10 of 50 chars shown]");
    expect(isTruncated(result)).toBe(true);
  });

  it("reports the exact shown/total numbers in the marker", () => {
    expect(truncateText("abcdefghij", 4)).toBe("abcd\n… [truncated, 4 of 10 chars shown]");
  });

  it("never shortens content without leaving a detectable marker (negative control)", () => {
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(Math.random() * 300);
      const limit = Math.floor(Math.random() * 300);
      const input = "x".repeat(len);
      const result = truncateText(input, limit);
      if (result.length < input.length) {
        expect(isTruncated(result)).toBe(true);
      }
    }
  });

  it("leaves text unchanged at the exact boundary text.length === maxChars", () => {
    const text = "12345";
    const result = truncateText(text, 5);
    expect(result).toBe(text);
    expect(isTruncated(result)).toBe(false);
  });

  it("shows zero content chars for maxChars 0", () => {
    const result = truncateText("hello", 0);
    expect(result).toBe("\n… [truncated, 0 of 5 chars shown]");
    expect(isTruncated(result)).toBe(true);
  });

  it("treats a negative maxChars as 0", () => {
    const result = truncateText("hello", -5);
    expect(result).toBe("\n… [truncated, 0 of 5 chars shown]");
    expect(isTruncated(result)).toBe(true);
  });

  it("handles an empty string without throwing", () => {
    expect(truncateText("", 10)).toBe("");
    expect(isTruncated(truncateText("", 10))).toBe(false);
  });

  it("handles null/undefined cast through as unknown as string without throwing", () => {
    expect(() => truncateText(null as unknown as string, 10)).not.toThrow();
    expect(truncateText(null as unknown as string, 10)).toBe("");
    expect(() => truncateText(undefined as unknown as string, 10)).not.toThrow();
    expect(truncateText(undefined as unknown as string, 10)).toBe("");
  });
});

describe("truncateForDisplay", () => {
  it("returns text at or below the limit unchanged, with no ellipsis", () => {
    const text = "hello";
    const result = truncateForDisplay(text, 5);
    expect(result).toBe(text);
    expect(isDisplayTruncated(result)).toBe(false);
  });

  it("cuts text above the limit to exactly maxChars plus a single ellipsis", () => {
    expect(truncateForDisplay("abcdefghij", 4)).toBe("abcd…");
  });

  it("leaves text unchanged at the exact boundary text.length === maxChars", () => {
    const text = "12345";
    const result = truncateForDisplay(text, 5);
    expect(result).toBe(text);
    expect(isDisplayTruncated(result)).toBe(false);
  });

  it("shows zero content chars for maxChars 0", () => {
    expect(truncateForDisplay("hello", 0)).toBe("…");
  });

  it("treats a negative maxChars as 0", () => {
    expect(truncateForDisplay("hello", -5)).toBe("…");
  });

  it("handles an empty string without throwing", () => {
    expect(truncateForDisplay("", 10)).toBe("");
    expect(isDisplayTruncated(truncateForDisplay("", 10))).toBe(false);
  });

  it("handles null/undefined cast through as unknown as string without throwing", () => {
    expect(() => truncateForDisplay(null as unknown as string, 10)).not.toThrow();
    expect(truncateForDisplay(null as unknown as string, 10)).toBe("");
    expect(() => truncateForDisplay(undefined as unknown as string, 10)).not.toThrow();
    expect(truncateForDisplay(undefined as unknown as string, 10)).toBe("");
  });

  it("isDisplayTruncated is true only when the ellipsis marker is present", () => {
    expect(isDisplayTruncated("abcd…")).toBe(true);
    expect(isDisplayTruncated("abcd")).toBe(false);
  });

  it("never shortens content without leaving a detectable ellipsis (negative control)", () => {
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(Math.random() * 300);
      const limit = Math.floor(Math.random() * 300);
      const input = "x".repeat(len);
      const result = truncateForDisplay(input, limit);
      if (result.length < input.length) {
        expect(isDisplayTruncated(result)).toBe(true);
      }
    }
  });

  it("never introduces a newline when the input has none", () => {
    const input = "the quick brown fox jumps over the lazy dog".repeat(3);
    const result = truncateForDisplay(input, 20);
    expect(result).not.toContain("\n");
  });
});

describe("TRUNCATION_MARKER_PATTERN", () => {
  it("has no g flag, to avoid stateful-regex bugs in isTruncated", () => {
    expect(TRUNCATION_MARKER_PATTERN.flags).not.toContain("g");
  });
});

describe("truncateDiagnosticBody", () => {
  let dumpDir: string | undefined;

  afterEach(() => {
    delete process.env.ABAPSMITH_BODY_DUMP_DIR;
    if (dumpDir) {
      rmSync(dumpDir, { recursive: true, force: true });
      dumpDir = undefined;
    }
  });

  it("behaves exactly like truncateText when ABAPSMITH_BODY_DUMP_DIR is unset", () => {
    delete process.env.ABAPSMITH_BODY_DUMP_DIR;
    const body = "z".repeat(DIAGNOSTIC_BODY_MAX + 500);
    const result = truncateDiagnosticBody(body);
    expect(result).toBe(truncateText(body, DIAGNOSTIC_BODY_MAX));
  });

  it("spills the full body to disk and references it in the marker when the env var is set", () => {
    dumpDir = mkdtempSync(join(tmpdir(), "abapsmith-truncate-test-"));
    process.env.ABAPSMITH_BODY_DUMP_DIR = dumpDir;

    const body = "q".repeat(50000);
    const result = truncateDiagnosticBody(body, DIAGNOSTIC_BODY_MAX);

    expect(result).toContain("full body written to");
    expect(isTruncated(result)).toBe(true);

    const match = result.match(/full body written to (.+)\]$/);
    expect(match).not.toBeNull();
    const filePath = (match as RegExpMatchArray)[1];
    const written = readFileSync(filePath, "utf8");
    expect(written.length).toBe(50000);
    expect(written).toBe(body);
  });

  it("falls back to the plain marker without throwing when the dump path is unwritable", () => {
    // A regular file blocking a path component makes mkdirSync fail with
    // ENOTDIR regardless of the process's effective permissions (unlike a
    // plain permission-denied path, which root can bypass).
    const blockerDir = mkdtempSync(join(tmpdir(), "abapsmith-truncate-test-blocker-"));
    const blockerFile = join(blockerDir, "not-a-directory");
    writeFileSync(blockerFile, "blocker");
    process.env.ABAPSMITH_BODY_DUMP_DIR = join(blockerFile, "sub", "dir");
    const body = "w".repeat(DIAGNOSTIC_BODY_MAX + 100);
    let result = "";
    expect(() => {
      result = truncateDiagnosticBody(body);
    }).not.toThrow();
    expect(isTruncated(result)).toBe(true);
    rmSync(blockerDir, { recursive: true, force: true });
  });
});
