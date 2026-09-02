#!/usr/bin/env node
// Lint: flags caller-facing strings (error messages, `denied()`/`AbapError`
// hints, `.describe()` text, `notes.push()` text) that name a tool parameter
// in camelCase when the real zod schema field is snake_case. An agent that
// follows such a hint literally gets a schema rejection and burns a round
// trip — measured live against a real system (ARCH-09 live-tool-metrics
// review, finding §5.4 / P5). That review recorded three recurrences of this
// exact bug before this guard existed; this script is the lint it asked for
// instead of a fourth one-off fix.
//
// Run: node scripts/lint-hint-params.mjs   (also `npm run lint:hints`)
//
// --- Approach -----------------------------------------------------------
//
// Step 1 (exact, not heuristic): parse every src/tools/**/*.ts file with the
// TypeScript compiler API and collect the REAL schema field names — any
// object-literal property whose value is a call chain rooted at the `z`
// identifier (e.g. `object_type: z.string()...`, or the `old_string` inside a
// nested `z.object({...})`). This is a structural fact about the AST, not a
// regex heuristic, and it does not require a build: it reads source directly,
// so it always reflects the current tree, including edits other agents have
// not yet built or committed.
//
// Why not `import` the compiled schemas from dist/ and walk `.shape` (the
// "even more exact" option this task suggested)? Two reasons, both concrete
// to this repo: (1) `dist/` is a stale, gitignored build artifact — nothing
// keeps it in sync with a source tree that multiple agents are editing
// concurrently, so importing it risks silently checking yesterday's schema;
// rebuilding on every lint run is possible but adds a slow, failure-prone
// step (tsc over the whole tree) to what should be a fast static check.
// (2) importing the compiled tool modules executes their top-level code,
// which is a real side-effect risk in a repo whose modules reach into
// config/env handling — a lint script should not need to be a valid runtime
// entry point. Parsing source with the TS compiler API gets the same
// exactness (it is the real parser, not a fragile regex) without either cost.
//
// Honest limitation (field extraction): this only sees fields declared as
// object-literal properties whose value is a `z.`-rooted expression, found
// ANYWHERE in src/tools/**/*.ts (not just inside a `*InputSchema`-named
// const — that naming convention is NOT load-bearing here, which matters
// because `dumps.ts`'s `dumpsInputSchema` is a *function*, and the real
// shape comes from `tier1Shape()`/`tier2Shape()` object literals it
// returns). A field built by some other mechanism — a computed key, a schema
// assembled via `Object.fromEntries`, or a shape imported from outside
// src/tools — would not be seen and would be a silent false negative. None
// of those patterns exist in this codebase today (checked by grep for
// `z.object(` call sites and for computed keys in schema-shaped literals);
// if one is added later, this script's exactness claim should be
// re-verified.
//
// Step 2 (sink-scoped, not whole-file): a first version of this script
// scanned every string/template literal anywhere in src/**/*.ts. That is
// exact about *matching* but wildly over-broad about *scope*: it also lit up
// on TS literal-type unions (`"configId" | "configType"`), a 180-line
// embedded ABAP-source template literal in fpm-lock.ts (generated bridge
// class code the calling agent never sees), and string arguments to
// internal, non-caller-facing helpers like an XML `attr(node, "riskLevel")`
// reader — none of which an MCP client ever receives. A lint nobody can keep
// green gets deleted, so this version instead only scans text inside
// recognized "caller-facing sink" positions:
//   - `<expr>.describe(...)` — the zod schema description shown to clients.
//   - `new AbapError(...)` — message/details/hint constructor arguments.
//   - a call to an identifier matching /^(denied|granted|notNeeded|deny)$/i,
//     or starting with `refuse`/`reject`, or ending in `Hint` — this
//     codebase's own naming convention for refusal/hint builders (grep
//     confirms `denied`, `refuseCsrfRecoveryInStatefulSession`,
//     `refuseEnhancementDebugTarget`, `rejectCrossModeArgs`, `dumpHint`,
//     `undoHint`, etc.).
//   - `notes.push(...)` / `warnings.push(...)` / `messages.push(...)` — the
//     codebase's convention (159 call sites across 21+ files) for
//     accumulating text that ships in a tool response.
//   - an object-literal property keyed `hint`, `message`, `reason`,
//     `meaning`, or `note` — covers data-driven refusal tables such as
//     `enhancement-refusals.ts`'s `SapRefusal.meaning`, which is spliced
//     into a caller-facing `AbapError` message downstream even though the
//     property itself isn't a direct call argument.
// Within a sink argument/value, string concatenation (`+`) and `? :` are
// followed so a hint built from pieces is still scanned; nested calls,
// identifiers, and array/object payloads that aren't one of the keys above
// are not descended into (that is what excluded the `details` debug-object
// argument to AbapError and the ABAP-source template literal).
//
// Honest limitation (scan scope): a hint string assigned to a local variable
// and thrown some other way (`const h = "..."; throw new Error(h)`), or a
// plain `throw new Error(...)` outside the AbapError/denied/refuse/reject
// convention, is NOT scanned. A quick survey found ~36 such plain
// `throw new Error(...)` sites, but they are process/startup-level failures
// (config.ts, circuit-breaker.ts, session-lock.ts, shutdown-hook.ts, ...),
// not MCP tool responses — adding them as a sink without an observed hint
// bug there would trade false negatives we don't know we have for false
// positives we would. If a fourth recurrence of this bug class shows up
// through a different sink, extend the sink list above rather than reverting
// to whole-file scanning.
//
// Suppression: put `lint-hint-params-ignore` in a comment on the offending
// line, or on the line immediately above it, with a short reason. Use it for
// genuine false positives (documented, not to silence a real hit).

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, extname } from "node:path";
import ts from "typescript";

const ROOT = new URL("..", import.meta.url).pathname;
const SUPPRESS_MARKER = "lint-hint-params-ignore";
const HINT_KEYS = new Set(["hint", "message", "reason", "meaning", "note"]);
const PUSH_RECEIVERS = new Set(["notes", "warnings", "messages"]);

function walkTsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walkTsFiles(p));
    } else if (e.isFile() && extname(e.name) === ".ts") {
      out.push(p);
    }
  }
  return out;
}

// `fooBar` -> `foo_bar`; `nodeID` -> `node_id`. Same shape as the codebase's
// own snake_case field names, so this is the exact inverse of how a human
// would misremember `object_type` as `objectType`.
export function toSnakeCase(token) {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

// Only tokens shaped like genuine camelCase identifiers: lowercase start,
// at least one internal uppercase transition. Excludes ALL-CAPS acronyms
// (TRKORR), PascalCase type names (AbapError — never a real field anyway,
// since every zod field name is lowercase-leading), and plain snake_case or
// lowercase prose words, which would be no-ops under toSnakeCase and could
// otherwise trivially "match" a same-spelled real field.
export function isCamelToken(token) {
  return /^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(token);
}

function isZodRooted(node) {
  let cur = node;
  for (;;) {
    if (ts.isCallExpression(cur) || ts.isNewExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else {
      break;
    }
  }
  return ts.isIdentifier(cur) && cur.text === "z";
}

/**
 * Collect real zod field names from a parsed source file: any object-literal
 * property whose initializer is a call chain rooted at identifier `z`.
 * Exported so the test can feed it hand-written source without touching disk.
 */
export function collectRealFieldsFromSource(text, fileName = "schema.ts") {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fields = new Set();
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const key = node.name;
      let name;
      if (ts.isIdentifier(key)) name = key.text;
      else if (ts.isStringLiteral(key)) name = key.text;
      if (name !== undefined && isZodRooted(node.initializer)) {
        fields.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return fields;
}

function collectRealFields(files) {
  const fields = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const f of collectRealFieldsFromSource(text, file)) fields.add(f);
  }
  return fields;
}

function isSuppressed(lines, lineIndex) {
  const here = lines[lineIndex] ?? "";
  const prev = lines[lineIndex - 1] ?? "";
  return here.includes(SUPPRESS_MARKER) || prev.includes(SUPPRESS_MARKER);
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

// Does `expr` look like a caller-facing refusal/hint builder call, per this
// codebase's own naming convention (denied, refuseX, rejectX, xHint, ...)?
function isHintBuilderCall(name) {
  if (name === undefined) return false;
  if (/^(denied|granted|notNeeded|deny)$/i.test(name)) return true;
  if (/^(refuse|reject)/i.test(name)) return true;
  if (/Hint$/.test(name)) return true;
  return false;
}

function isPushOnAccumulator(node) {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (expr.name.text !== "push") return false;
  return ts.isIdentifier(expr.expression) && PUSH_RECEIVERS.has(expr.expression.text);
}

function isDescribeCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const expr = node.expression;
  return ts.isPropertyAccessExpression(expr) && expr.name.text === "describe";
}

function isNewAbapError(node) {
  return ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "AbapError";
}

/**
 * Scan one already-parsed source file for camelCase tokens, inside
 * recognized caller-facing sinks only, whose snake_case form is a real
 * field. Exported for the unit test.
 */
export function findHintViolationsInSource(text, realFields, fileName = "file.ts") {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = text.split("\n");
  const findings = [];
  let suppressedCount = 0;

  const checkFragment = (fragmentText, node) => {
    const tokens = fragmentText.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
    for (const token of tokens) {
      if (!isCamelToken(token)) continue;
      const snake = toSnakeCase(token);
      if (!realFields.has(snake)) continue;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      if (isSuppressed(lines, line)) {
        suppressedCount++;
        continue;
      }
      findings.push({ line: line + 1, token, snake, text: fragmentText.trim().slice(0, 100) });
    }
  };

  // Scan a value found inside a recognized sink: literals directly, through
  // `+` concatenation and `? :`, and into nested object properties keyed
  // hint/message/reason/meaning/note. Does not descend into calls,
  // identifiers, or arbitrary object/array payloads (that is what keeps the
  // AbapError `details` argument and unrelated nested calls out of scope).
  const scanSinkValue = (node) => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      checkFragment(node.text, node);
    } else if (ts.isTemplateExpression(node)) {
      checkFragment(node.head.text, node.head);
      for (const span of node.templateSpans) checkFragment(span.literal.text, span.literal);
    } else if (ts.isParenthesizedExpression(node)) {
      scanSinkValue(node.expression);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      scanSinkValue(node.left);
      scanSinkValue(node.right);
    } else if (ts.isConditionalExpression(node)) {
      scanSinkValue(node.whenTrue);
      scanSinkValue(node.whenFalse);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = prop.name;
        const keyText = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
        if (keyText !== undefined && HINT_KEYS.has(keyText)) scanSinkValue(prop.initializer);
      }
    }
  };

  const visit = (node) => {
    if (isDescribeCall(node)) {
      const [arg] = node.arguments;
      scanSinkValue(arg);
    } else if (
      isNewAbapError(node) ||
      isPushOnAccumulator(node) ||
      ((ts.isCallExpression(node) || ts.isNewExpression(node)) && isHintBuilderCall(calleeName(node.expression)))
    ) {
      for (const arg of node.arguments ?? []) scanSinkValue(arg);
    } else if (ts.isPropertyAssignment(node)) {
      const key = node.name;
      const keyText = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
      if (keyText !== undefined && HINT_KEYS.has(keyText)) scanSinkValue(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { findings, suppressedCount };
}

function main() {
  const toolsDir = join(ROOT, "src", "tools");
  const srcDir = join(ROOT, "src");

  const schemaFiles = walkTsFiles(toolsDir);
  const realFields = collectRealFields(schemaFiles);

  const scanFiles = walkTsFiles(srcDir);
  const allFindings = [];
  let totalSuppressed = 0;

  for (const file of scanFiles) {
    const text = readFileSync(file, "utf8");
    const { findings, suppressedCount } = findHintViolationsInSource(text, realFields, file);
    totalSuppressed += suppressedCount;
    for (const f of findings) {
      allFindings.push({ file: relative(ROOT, file), ...f });
    }
  }

  console.log(
    `lint:hints — ${realFields.size} real field(s) extracted from ${schemaFiles.length} file(s) under src/tools; ` +
      `scanned ${scanFiles.length} file(s) under src/.`,
  );
  if (totalSuppressed > 0) {
    console.log(`  ${totalSuppressed} finding(s) suppressed via "${SUPPRESS_MARKER}".`);
  }

  if (allFindings.length === 0) {
    console.log("lint:hints: clean — no camelCase reference to a snake_case zod field found in a caller-facing sink.");
    process.exit(0);
  }

  console.error(`\nlint:hints: ${allFindings.length} violation(s):\n`);
  for (const f of allFindings) {
    console.error(`  ${f.file}:${f.line}  "${f.token}" should be "${f.snake}"`);
    console.error(`      ${f.text}`);
  }
  console.error(
    `\nEach line above names a real zod field (see src/tools/**/*.ts) in camelCase inside caller-facing ` +
      `text. Fix the string to use the snake_case field name the agent actually has to pass. If this is a ` +
      `genuine false positive (not a schema field reference), suppress it with a "${SUPPRESS_MARKER}" ` +
      `comment on the same or preceding line, with a reason — do not weaken this rule.`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
