/**
 * Unit tests for scripts/lint-hint-params.mjs — the guard against
 * caller-facing hint text naming a real zod field in camelCase (see
 * the ARCH-09 live-tool-metrics review, §5.4 / P5). These feed hand-written
 * source strings straight to the script's exported functions, so they run
 * fully offline and do not depend on the current state of src/.
 */
import { describe, expect, it } from "vitest";
import {
  collectRealFieldsFromSource,
  findHintViolationsInSource,
  isCamelToken,
  toSnakeCase,
} from "../scripts/lint-hint-params.mjs";

describe("toSnakeCase / isCamelToken", () => {
  it("converts camelCase to snake_case", () => {
    expect(toSnakeCase("corrNr")).toBe("corr_nr");
    expect(toSnakeCase("objectType")).toBe("object_type");
  });

  it("recognizes camelCase tokens only", () => {
    expect(isCamelToken("corrNr")).toBe(true);
    expect(isCamelToken("corr_nr")).toBe(false);
    expect(isCamelToken("TRKORR")).toBe(false);
    expect(isCamelToken("AbapError")).toBe(false);
  });
});

describe("collectRealFieldsFromSource", () => {
  it("collects object-literal keys whose value is z.-rooted, anywhere in the file", () => {
    const src = `
      export const writeInputSchema = {
        corr_nr: z.string().optional().describe("Transport request"),
        object: z.string(),
      };
      function tier1Shape() {
        return { max_rows: z.number().int() };
      }
    `;
    const fields = collectRealFieldsFromSource(src);
    expect(fields.has("corr_nr")).toBe(true);
    expect(fields.has("object")).toBe(true);
    expect(fields.has("max_rows")).toBe(true);
  });

  it("does not collect plain (non z.-rooted) object-literal properties", () => {
    const src = `const details = { query: input.query, corrNr: info.corrNr };`;
    const fields = collectRealFieldsFromSource(src);
    expect(fields.size).toBe(0);
  });
});

describe("findHintViolationsInSource", () => {
  const realFields = new Set(["corr_nr", "object_type", "max_rows"]);

  it("true positive: flags a camelCase field name inside a denied() hint", () => {
    const src = `
      throw denied("not-allowlisted", "TRANSPORT_ERROR", "no transport",
        'Pass a corrNr, or set ABAP_ALLOW_TRANSPORTS=auto.');
    `;
    const { findings } = findHintViolationsInSource(src, realFields);
    expect(findings).toHaveLength(1);
    expect(findings[0].token).toBe("corrNr");
    expect(findings[0].snake).toBe("corr_nr");
  });

  it("true positive: flags a camelCase field name inside a new AbapError(...) message", () => {
    const src = `
      throw new AbapError(
        "BAD_INPUT",
        \`maxRows must be a positive integer, got \${String(maxRows)}.\`,
        { maxRows },
      );
    `;
    const { findings } = findHintViolationsInSource(src, realFields);
    expect(findings.map((f) => f.token)).toContain("maxRows");
  });

  it("true positive: flags text pushed onto a notes accumulator", () => {
    const src = `
      notes.push("Transportable: write with no corrNr returns a clean 200 either way.");
    `;
    const { findings } = findHintViolationsInSource(src, realFields);
    expect(findings.map((f) => f.token)).toContain("corrNr");
  });

  it("near-miss: does NOT flag a camelCase word that is not a real field's snake_case spelling", () => {
    // "riskLevel" -> "risk_level", which is not in realFields — ordinary
    // prose/attribute name, must not be flagged no matter where it appears.
    const src = `
      throw new AbapError("BAD_INPUT", "unexpected riskLevel value", {});
    `;
    const { findings } = findHintViolationsInSource(src, realFields);
    expect(findings).toHaveLength(0);
  });

  it("near-miss: does NOT flag a real field's camelCase spelling outside a recognized sink", () => {
    // Same token as the first true-positive case, but this is a plain
    // internal TS interface field access, not caller-facing text inside a
    // hint/message/notes sink — must not be flagged.
    const src = `
      interface TransportInfo {
        corrNr?: string;
      }
      const qs: Record<string, string> = { objectType: input.objectType };
    `;
    const { findings } = findHintViolationsInSource(src, realFields);
    expect(findings).toHaveLength(0);
  });

  it("near-miss: does NOT flag TS literal-type unions even when they share a sink's syntax shape", () => {
    const src = `
      const seg = (name: "configId" | "configType"): string => name;
    `;
    const fields = new Set(["config_id", "config_type"]);
    const { findings } = findHintViolationsInSource(src, fields);
    expect(findings).toHaveLength(0);
  });

  it("respects the lint-hint-params-ignore suppression marker", () => {
    const src = `
      // lint-hint-params-ignore: XML wire attribute name, not caller-facing
      throw denied("x", "TRANSPORT_ERROR", "r", "Pass a corrNr");
    `;
    const { findings, suppressedCount } = findHintViolationsInSource(src, realFields);
    expect(findings).toHaveLength(0);
    expect(suppressedCount).toBe(1);
  });
});
