#!/usr/bin/env node
/**
 * `abap-contract` — subprocess entry point for `abap_read view:"contract"`.
 * Uses `@abaplint/core` to parse ABAP source and build a definition-only
 * "contract" view (class/interface signatures, method bodies stripped).
 *
 * Runs as a CHILD PROCESS, not imported by the main server: this project
 * ships five runtime deps total, and `@abaplint/core` alone is ~4MB
 * unpacked. `src/tools/v2/handlers/read.ts` spawns the compiled
 * `dist/bin/contract.js` rather than importing this module directly, so
 * the dependency stays quarantined to a short-lived process.
 *
 * Parser only: calls `Registry.parse()`, never `Registry.findIssues()`
 * (abaplint's lint engine — that's ATC's job, not this module's).
 *
 * Algorithm: slice the ORIGINAL source by token position rather than
 * re-synthesising declarations from abaplint's semantic model (rejected —
 * see the git history) or regex (unreliable against
 * ABAP's chained-declaration/string-template syntax). `CLASS…DEFINITION…
 * ENDCLASS` blocks (signatures, minus `PRIVATE SECTION`) are kept verbatim;
 * `CLASS…IMPLEMENTATION` blocks (method bodies) become a one-line
 * placeholder. `INTERFACE…ENDINTERFACE` has no implementation block, so an
 * INTF's "contract" is its whole source, unmodified.
 *
 * Known gaps (see archive for full detail):
 * - Unparseable source falls back to returning it unmodified, with a note.
 * - Multiple local classes in one file: all DEFINITION blocks kept, all
 *   IMPLEMENTATION blocks stripped, in document order — not exercised
 *   against a real multi-local-class main include.
 * - "N line(s) omitted" counts assume single-line block headers/footers.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ABAPObject, Registry, MemoryFile, Structures } from "@abaplint/core";

export type ContractKind = "CLAS" | "INTF";

export interface ContractExtraction {
  /** The extracted, definition-only ABAP-like text. */
  text: string;
  /** Plain sentences, no "NOTE:" prefix — the caller (compact.ts's `buildResponse`) adds that. */
  notes: string[];
}

/** Minimal shape this module needs from abaplint's `Position`/`Token`. */
interface RowBearing {
  getRow(): number;
}

/** 1-based, inclusive row range. */
function rowRangeOf(node: { getFirstToken(): RowBearing; getLastToken(): RowBearing }): [number, number] {
  return [node.getFirstToken().getRow(), node.getLastToken().getRow()];
}

/**
 * Extracts a definition-only "contract" view of a class or interface's
 * already-fetched ABAP source. Pure text transform — no ADT connection, no
 * filesystem/network access. See the module header for the full algorithm.
 */
export function extractContract(source: string, kind: ContractKind, name: string): ContractExtraction {
  const rows = source.replace(/\r\n/g, "\n").split("\n");
  const notes: string[] = [];

  const safeName = (name.trim() || "object").toLowerCase().replace(/[^a-z0-9_/]/gi, "_");
  const filename = kind === "CLAS" ? `${safeName}.clas.abap` : `${safeName}.intf.abap`;

  const registry = new Registry();
  registry.addFile(new MemoryFile(filename, source));
  registry.parse();

  const obj = registry.getFirstObject();
  // getSequencedFiles() only exists on ABAPObject subclasses (Class, Interface), not IObject —
  // a real runtime narrowing, not a cast.
  if (!obj || !(obj instanceof ABAPObject)) {
    notes.push("abaplint produced no object for this source — returning it unmodified.");
    return { text: source, notes };
  }

  const file = obj.getSequencedFiles()[0];
  const structure = file?.getStructure();
  if (!structure) {
    notes.push(
      "abaplint could not build a structure tree for this source (unrecognised syntax, or a genuine " +
        "parse failure) — returning the raw source unmodified rather than guessing at a contract.",
    );
    return { text: source, notes };
  }

  const sliceRows = (from: number, to: number): string => rows.slice(from - 1, to).join("\n");

  const classDefs = structure.findAllStructures(Structures.ClassDefinition);
  const classImpls = structure.findAllStructures(Structures.ClassImplementation);

  if (classDefs.length === 0 && classImpls.length === 0) {
    notes.push(
      kind === "INTF"
        ? "INTF objects have no METHOD … ENDMETHOD bodies to strip in the first place — this IS the " +
          "whole interface source, unmodified."
        : "No CLASS DEFINITION/IMPLEMENTATION block was found by the parser for this CLAS object — " +
          "returning the raw source unmodified rather than guessing at a contract.",
    );
    return { text: source, notes };
  }

  interface Block {
    start: number;
    render: () => string;
  }
  const blocks: Block[] = [];
  let privateSectionsExcised = 0;

  for (const cd of classDefs) {
    const [start, end] = rowRangeOf(cd);
    blocks.push({
      start,
      render: () => {
        const priv = cd.findFirstStructure(Structures.PrivateSection);
        if (!priv) return sliceRows(start, end);
        const [pStart, pEnd] = rowRangeOf(priv);
        privateSectionsExcised++;
        const omitted = pEnd - pStart + 1;
        return [
          sliceRows(start, pStart - 1),
          `    " PRIVATE SECTION omitted (${omitted} line(s)) — not part of the public contract.`,
          sliceRows(pEnd + 1, end),
        ].join("\n");
      },
    });
  }

  for (const ci of classImpls) {
    const [start, end] = rowRangeOf(ci);
    blocks.push({
      start,
      render: () => {
        const headerLine = rows[start - 1] ?? "CLASS … IMPLEMENTATION.";
        const lastLine = rows[end - 1] ?? "ENDCLASS.";
        const omitted = Math.max(0, end - start - 1);
        return [headerLine, `  " ${omitted} line(s) of method bodies omitted — not part of the public contract.`, lastLine].join(
          "\n",
        );
      },
    });
  }

  blocks.sort((a, b) => a.start - b.start);
  const text = blocks.map((b) => b.render()).join("\n\n");

  if (classImpls.length > 0) {
    notes.push(
      `${classImpls.length} CLASS … IMPLEMENTATION block(s) reduced to a one-line placeholder each ` +
        "(method bodies carry no public contract).",
    );
  }
  if (privateSectionsExcised > 0) {
    notes.push(
      `${privateSectionsExcised} PRIVATE SECTION block(s) excised (not part of the public contract).`,
    );
  }
  if (classDefs.length > 1 || classImpls.length > 1) {
    notes.push(
      `This source held ${classDefs.length} CLASS DEFINITION and ${classImpls.length} CLASS ` +
        "IMPLEMENTATION block(s) (local helper classes alongside the main one, most likely) — every " +
        "DEFINITION block found was kept, every IMPLEMENTATION block found was stripped.",
    );
  }

  return { text, notes };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * CLI: `abap-contract <CLAS|INTF> <NAME>`, source on stdin.
 * stdout (exit 0): extracted contract text, and only that.
 * stderr: note lines — informational on success, error detail on failure.
 */
async function main(): Promise<void> {
  const [rawKind, rawName] = process.argv.slice(2);
  const kind = (rawKind ?? "").trim().toUpperCase();
  const name = (rawName ?? "").trim();

  if (kind !== "CLAS" && kind !== "INTF") {
    process.stderr.write(
      `abap-contract: usage: abap-contract <CLAS|INTF> <NAME> < source.abap (got kind="${rawKind ?? ""}")\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (!name) {
    process.stderr.write("abap-contract: the object NAME argument is required.\n");
    process.exitCode = 2;
    return;
  }

  const source = await readStdin();
  if (source.trim() === "") {
    process.stderr.write("abap-contract: empty source on stdin — nothing to extract.\n");
    process.exitCode = 2;
    return;
  }

  try {
    const { text, notes } = extractContract(source, kind, name);
    for (const note of notes) process.stderr.write(note + "\n");
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  } catch (e) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write(`abap-contract: extraction failed: ${msg}\n`);
    process.exitCode = 1;
  }
}

/** Same pattern as `src/index.ts`'s `invokedAsProgram` — lets
 *  `test/contract.test.ts` import {@link extractContract} without running
 *  the CLI (which would read real stdin and call `process.exit`). */
function invokedAsProgram(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsProgram()) {
  main().catch((e) => {
    process.stderr.write(`abap-contract: fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exitCode = 1;
  });
}
