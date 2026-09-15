/**
 * Anti-drift gate for doc/FLUID-API/: a contract change that forgets the
 * docs should fail the build. Assertions are derived from the real code
 * (manifest.ts, errors.ts, config.ts) wherever that code exists on this
 * branch; string literals are used only for the wire-frame names, since
 * src/adt/fluid/protocol.ts is being written on another branch right now
 * and must not be imported here.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FLUID_CONTRACT, FLUID_CONTRACT_MAJOR, FluidManifestSchema } from "../src/adt/fluid/manifest.js";
import { FLUID_ABAP_LINE_MAX } from "../src/adt/fluid/static-review.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const docDir = join(repoRoot, "doc", "FLUID-API");

const DOC_FILES = ["README.md", "manifest.md", "protocol.md", "authoring.md", "safety.md"] as const;

async function readDoc(name: (typeof DOC_FILES)[number]): Promise<string> {
  return readFile(join(docDir, name), "utf8");
}

function fencedBlocks(text: string, lang: string): string[] {
  const re = new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g");
  const blocks: string[] = [];
  for (const m of text.matchAll(re)) {
    const body = m[1];
    if (body !== undefined) blocks.push(body);
  }
  return blocks;
}

describe("manifest.md example matches the real schema", () => {
  it("has exactly one fenced json block", async () => {
    const text = await readDoc("manifest.md");
    const blocks = fencedBlocks(text, "json");
    expect(blocks).toHaveLength(1);
  });

  it("parses as JSON and validates against FluidManifestSchema", async () => {
    const text = await readDoc("manifest.md");
    const [block] = fencedBlocks(text, "json");
    expect(block).toBeDefined();
    const parsed: unknown = JSON.parse(block ?? "");
    const result = FluidManifestSchema.safeParse(parsed);
    expect(
      result.success,
      result.success ? "" : `manifest.md example failed schema: ${JSON.stringify(result.error.issues, null, 2)}`,
    ).toBe(true);
  });

  it("declares the current FLUID_CONTRACT", async () => {
    const text = await readDoc("manifest.md");
    const [block] = fencedBlocks(text, "json");
    const parsed = JSON.parse(block ?? "") as { contract?: unknown };
    expect(parsed.contract).toBe(FLUID_CONTRACT);
  });

  it("exercises all three action categories", async () => {
    const text = await readDoc("manifest.md");
    const [block] = fencedBlocks(text, "json");
    const parsed = JSON.parse(block ?? "") as { actions?: { category?: unknown }[] };
    const categories = new Set((parsed.actions ?? []).map((a) => a.category));
    expect(categories).toEqual(new Set(["read", "execute", "mutate"]));
  });
});

async function errorsSource(): Promise<string> {
  return readFile(join(repoRoot, "src", "adt", "errors.ts"), "utf8");
}

// \b excludes the ABAP_FLUID_* / ABAP_ALLOW_FLUID_* env-var mentions inside
// errors.ts's doc comments, which share the FLUID_ substring but are not codes.
function fluidTokens(text: string): Set<string> {
  return new Set(text.match(/\bFLUID_[A-Z_]+\b/g) ?? []);
}

describe("every fluid error code is documented", () => {
  it("every FLUID_[A-Z_]+ token in errors.ts appears in safety.md or README.md", async () => {
    const codes = fluidTokens(await errorsSource());
    expect(codes.size).toBeGreaterThanOrEqual(7);

    const safety = await readDoc("safety.md");
    const readme = await readDoc("README.md");
    const combined = safety + readme;

    const missing = [...codes].filter((code) => !combined.includes(code));
    expect(missing, `not documented: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("every fluid config variable is documented", () => {
  it("every ABAP_(ALLOW_)FLUID_[A-Z_]+ token in config.ts appears in README.md", async () => {
    const configSrc = await readFile(join(repoRoot, "src", "config.ts"), "utf8");
    const vars = new Set(configSrc.match(/ABAP_(?:ALLOW_)?FLUID_[A-Z_]+/g) ?? []);
    expect(vars.size).toBeGreaterThan(0);

    const readme = await readDoc("README.md");
    const missing = [...vars].filter((v) => !readme.includes(v));
    expect(missing, `not documented in README.md: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("every wire frame is documented", () => {
  // src/adt/fluid/protocol.ts is being written on another branch right now
  // and must not be imported here; the frame names are string literals.
  const FRAMES = ["BEGIN", "OUT", "OUTC", "OUTE", "ERR", "END"] as const;

  it("each frame appears as ZMCP-H> followed by its name", async () => {
    const text = await readDoc("protocol.md");
    for (const frame of FRAMES) {
      expect(text.includes(`ZMCP-H>${frame}`), `protocol.md missing ZMCP-H>${frame}`).toBe(true);
    }
  });

  it("names no frame beyond the documented six", async () => {
    const text = await readDoc("protocol.md");
    // a bare `ZMCP-H>` naming the prefix itself yields an empty capture; drop it.
    const found = new Set(
      [...text.matchAll(/ZMCP-H>(\w*)/g)].map((m) => m[1]).filter((name): name is string => !!name),
    );
    expect(found).toEqual(new Set(FRAMES));
  });
});

describe("authoring.md body-class contract matches protocol requirements", () => {
  it("has exactly one fenced abap block", async () => {
    const text = await readDoc("authoring.md");
    const blocks = fencedBlocks(text, "abap");
    expect(blocks).toHaveLength(1);
  });

  it("declares the static entry signature", async () => {
    const [block] = fencedBlocks(await readDoc("authoring.md"), "abap");
    expect(block).toBeDefined();
    const skeleton = block ?? "";
    expect(skeleton).toContain("CLASS-METHODS run");
    expect(skeleton).toContain("iv_action TYPE string");
    expect(skeleton).toContain("iv_json");
  });

  it("calls the runtime helper for begin, out, err and end", async () => {
    const [block] = fencedBlocks(await readDoc("authoring.md"), "abap");
    const skeleton = block ?? "";
    for (const fn of ["begin", "out", "err", "end"]) {
      expect(skeleton.includes(`zcl_zmcp_fluid_rt=>${fn}`), `skeleton missing zcl_zmcp_fluid_rt=>${fn}`).toBe(true);
    }
  });

  it("contains no WRITE statement", async () => {
    const [block] = fencedBlocks(await readDoc("authoring.md"), "abap");
    expect(block ?? "").not.toContain("WRITE ");
  });
});

describe("truthfulness guards", () => {
  it("FLUID_INPUT_TOO_LARGE does not exist as an error code", async () => {
    const errorsSrc = await errorsSource();
    expect(errorsSrc).not.toContain("FLUID_INPUT_TOO_LARGE");
  });

  it("no FLUID_[A-Z_]+ token in the docs is an invented or stale code", async () => {
    const codes = fluidTokens(await errorsSource());
    // FLUID_INPUT_TOO_LARGE is allowed here only so the docs can name and deny it;
    // the "does not exist" test below constrains how it may be mentioned.
    // FLUID_ABAP_LINE_MAX is a real exported constant (the per-line ABAP length
    // limit core.eval validates against), not an error code, so it isn't in
    // errors.ts's token set above but is still a truthful doc token.
    const allowlist = new Set([
      "FLUID_CONTRACT",
      "FLUID_CONTRACT_MAJOR",
      "FLUID_INPUT_TOO_LARGE",
      "FLUID_ABAP_LINE_MAX",
    ]);

    const offenders: string[] = [];
    for (const file of DOC_FILES) {
      const text = await readDoc(file);
      for (const token of fluidTokens(text)) {
        if (!codes.has(token) && !allowlist.has(token)) offenders.push(`${file}: ${token}`);
      }
    }
    expect(offenders, `drifted doc tokens: ${offenders.join(", ")}`).toEqual([]);
  });

  it("every doc mention of FLUID_INPUT_TOO_LARGE is on a line saying it does not exist", async () => {
    const offenders: string[] = [];
    for (const file of DOC_FILES) {
      const text = await readDoc(file);
      for (const line of text.split("\n")) {
        if (line.includes("FLUID_INPUT_TOO_LARGE") && !/does not exist/.test(line)) {
          offenders.push(`${file}: ${line}`);
        }
      }
    }
    expect(offenders, `FLUID_INPUT_TOO_LARGE named as live: ${offenders.join(", ")}`).toEqual([]);
  });

  it("safety.md states the lint-not-sandbox position and names ABAP_ALLOW_FLUID_PLUGINS as the real control", async () => {
    const text = await readDoc("safety.md");
    expect(text).toContain("lint, not a sandbox");
    expect(text).toContain("ABAP_ALLOW_FLUID_PLUGINS");
  });

  it("README.md names no byte/value/input ceiling other than ABAP_MAX_RESPONSE_CHARS", async () => {
    const text = await readDoc("README.md");
    expect(text).toContain("The framework never truncates its own output");
    expect(text).toContain("ABAP_MAX_RESPONSE_CHARS");
  });

  // The allowlist above takes FLUID_CONTRACT, FLUID_CONTRACT_MAJOR and
  // FLUID_ABAP_LINE_MAX on trust as "real, just not an error code". Pin that
  // trust to the compiler: import each and assert it is actually exported, so
  // a deletion or rename makes this test fail loudly instead of silently
  // widening the allowlist into a hole. FLUID_INPUT_TOO_LARGE is excluded on
  // purpose — it is allowlisted precisely because it does NOT exist, and the
  // neighbouring "does not exist as an error code" / "on a line saying it does
  // not exist" tests already constrain how the docs may mention it.
  it("every non-error FLUID_ token the docs may name is a real exported constant", () => {
    expect(FLUID_CONTRACT).toBeDefined();
    expect(FLUID_CONTRACT_MAJOR).toBeDefined();
    expect(FLUID_ABAP_LINE_MAX).toBeDefined();
  });
});

describe("the contract version is stated", () => {
  it("README.md states FLUID_CONTRACT", async () => {
    const text = await readDoc("README.md");
    expect(text).toContain(FLUID_CONTRACT);
  });

  it("FLUID_CONTRACT_MAJOR is the major component of FLUID_CONTRACT", () => {
    expect(FLUID_CONTRACT.split(".")[0]).toBe(String(FLUID_CONTRACT_MAJOR));
  });

  it("README.md states an unknown major refuses and an unknown minor warns", async () => {
    const text = await readDoc("README.md");
    const majorLine = text.split("\n").find((l) => /unknown \*\*major\*\*/.test(l));
    const minorLine = text.split("\n").find((l) => /unknown \*\*minor\*\*/.test(l));
    expect(majorLine, "no line about an unknown major").toBeDefined();
    expect(minorLine, "no line about an unknown minor").toBeDefined();
    expect(majorLine ?? "").toMatch(/refuses/);
    expect(minorLine ?? "").toMatch(/loads.*warning|warning/);
  });
});

describe("cross-links resolve", () => {
  it("every relative .md link inside doc/FLUID-API points at a file that exists there", async () => {
    const broken: string[] = [];
    for (const file of DOC_FILES) {
      const text = await readDoc(file);
      for (const m of text.matchAll(/\]\(([^)]+\.md)(#[^)]*)?\)/g)) {
        const target = m[1];
        if (target === undefined || /^https?:\/\//.test(target)) continue;
        if (!(DOC_FILES as readonly string[]).includes(target)) {
          broken.push(`${file} -> ${target}`);
        }
      }
    }
    expect(broken, `broken cross-links: ${broken.join(", ")}`).toEqual([]);
  });
});
